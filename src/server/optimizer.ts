import type {
  ColumnStats,
  FilterOp,
  JoinSpec,
  Plan,
  PlanNode,
  QuerySpec,
  StatsSnapshot,
} from './types';

export type OptimizerFlavor = 'legacy' | 'new';

// The schema is fixed server-side; gates never connect to a real database.
export const FIXED_SCHEMA = {
  tables: ['orders', 'customers', 'items'],
  indexes: ['orders.status', 'orders.customer_id', 'customers.id', 'items.id', 'items.sku'],
} as const;

// The two optimizer flavors deliberately disagree on costing so that some
// parameter values flip plan choices while others leave plans untouched.
const INDEX_SEL_THRESHOLD: Record<OptimizerFlavor, number> = { legacy: 0.25, new: 0.1 };
const NESTED_LOOP_MAX_RIGHT: Record<OptimizerFlavor, number> = { legacy: 1000, new: 100 };

function hasIndex(table: string, column: string): boolean {
  return (FIXED_SCHEMA.indexes as readonly string[]).includes(`${table}.${column}`);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Histograms are sorted bucket upper bounds; the k+1 buckets carry equal frequency.
function bucketIndex(h: number[], v: number): number {
  let i = 0;
  while (i < h.length && v > h[i]) i += 1;
  return i;
}

function bucketWidth(h: number[], i: number): number {
  const k = h.length;
  if (k >= 2) {
    if (i === 0) return h[1] - h[0];
    if (i >= k) return h[k - 1] - h[k - 2];
    return h[i] - h[i - 1];
  }
  return 1;
}

// Coarse step estimate used by the new optimizer (bucket boundary resolution).
export function stepLessThan(h: number[], v: number): number {
  return bucketIndex(h, v) / (h.length + 1);
}

export function stepGreaterThan(h: number[], v: number): number {
  return (h.length - bucketIndex(h, v)) / (h.length + 1);
}

// Interpolated "true" selectivity; acts as the actual-rows oracle for gating.
export function trueLessThan(h: number[], v: number): number {
  const k = h.length;
  const i = bucketIndex(h, v);
  const w = bucketWidth(h, i);
  const lo = i === 0 ? h[0] - w : h[i - 1];
  const hi = i < k ? h[i] : h[k - 1] + w;
  const frac = hi > lo ? clamp01((v - lo) / (hi - lo)) : 1;
  return (i + frac) / (k + 1);
}

export function estimateSelectivity(
  col: ColumnStats | undefined,
  op: FilterOp,
  value: number | string | undefined,
  flavor: OptimizerFlavor,
): number | null {
  if (!col) return null;
  if (op === 'eq') {
    if (typeof col.ndv !== 'number' || col.ndv <= 0) return null;
    const base = 1 / col.ndv;
    return flavor === 'legacy' ? Math.min(1, base * 1.5) : base;
  }
  if (typeof value !== 'number') return null;
  if (col.histogram && col.histogram.length > 0) {
    if (flavor === 'new') {
      return op === 'lt' ? stepLessThan(col.histogram, value) : stepGreaterThan(col.histogram, value);
    }
    return 1 / 3; // legacy ignores histograms and falls back to a flat heuristic
  }
  return typeof col.ndv === 'number' ? 1 / 3 : null;
}

export function trueSelectivity(
  col: ColumnStats | undefined,
  op: FilterOp,
  value: number | string | undefined,
): number | null {
  if (!col) return null;
  if (op === 'eq') return typeof col.ndv === 'number' && col.ndv > 0 ? 1 / col.ndv : null;
  if (typeof value !== 'number') return null;
  if (col.histogram && col.histogram.length > 0) {
    const lt = trueLessThan(col.histogram, value);
    return op === 'lt' ? lt : 1 - lt;
  }
  return null;
}

export function buildPlan(
  query: QuerySpec,
  params: Record<string, number | string>,
  stats: StatsSnapshot,
  flavor: OptimizerFlavor,
): Plan {
  const scan = (table: string): PlanNode => {
    const tstats = stats.tables[table];
    if (!tstats) throw new Error(`unknown_table:${table}`);
    let estSel = 1;
    let actualSel = 1;
    let estKnown = true;
    let actualKnown = true;
    let indexed = false;
    for (const f of query.filters) {
      if (f.table !== table) continue;
      const col = tstats.columns[f.column];
      const value = params[f.param];
      const est = estimateSelectivity(col, f.op, value, flavor);
      const act = trueSelectivity(col, f.op, value);
      if (est === null) estKnown = false;
      else estSel *= est;
      if (act === null) actualKnown = false;
      else actualSel *= act;
      if (hasIndex(table, f.column)) indexed = true;
    }
    const estRows = estKnown ? tstats.rowCount * estSel : null;
    const actualRows = actualKnown ? tstats.rowCount * actualSel : null;
    const selForChoice = estRows === null ? 1 : estRows / tstats.rowCount;
    const useIndex = indexed && selForChoice < INDEX_SEL_THRESHOLD[flavor];
    const estCost = (estRows ?? tstats.rowCount) * (useIndex ? 0.6 : 1);
    return {
      id: `scan:${table}`,
      op: useIndex ? 'IndexScan' : 'SeqScan',
      table,
      estRows,
      actualRows,
      estCost,
      children: [],
    };
  };

  const baseScan = scan(query.base);
  const joinScans = query.joins.map((spec) => ({ spec, node: scan(spec.table) }));
  if (flavor === 'new') {
    // The new optimizer reorders joins by estimated cardinality; legacy keeps
    // the declared order, so parameter swings can reorder the new plan tree.
    joinScans.sort((a, b) => rowsKey(a.node) - rowsKey(b.node));
  }
  let left = baseScan;
  for (const { spec, node } of joinScans) {
    left = joinNode(left, node, spec, stats, flavor);
  }
  return { optimizer: flavor, root: left };
}

function rowsKey(node: PlanNode): number {
  return node.estRows === null ? Number.MAX_VALUE : node.estRows;
}

function joinNode(
  left: PlanNode,
  right: PlanNode,
  spec: JoinSpec,
  stats: StatsSnapshot,
  flavor: OptimizerFlavor,
): PlanNode {
  const ndvL = stats.tables[spec.refTable]?.columns[spec.refColumn]?.ndv;
  const ndvR = stats.tables[spec.table]?.columns[spec.column]?.ndv;
  const sel =
    typeof ndvL === 'number' && typeof ndvR === 'number' && Math.max(ndvL, ndvR) > 0
      ? 1 / Math.max(ndvL, ndvR)
      : null;
  const estRows =
    sel !== null && left.estRows !== null && right.estRows !== null
      ? left.estRows * right.estRows * sel
      : null;
  const actualRows =
    sel !== null && left.actualRows !== null && right.actualRows !== null
      ? left.actualRows * right.actualRows * sel
      : null;
  const op =
    right.estRows !== null && right.estRows < NESTED_LOOP_MAX_RIGHT[flavor]
      ? 'NestedLoop'
      : 'HashJoin';
  const estCost = left.estCost + right.estCost + (estRows ?? 0) * 2;
  return {
    id: `join:${left.id}+${spec.table}`,
    op,
    table: spec.table,
    estRows,
    actualRows,
    estCost,
    children: [left, right],
  };
}
