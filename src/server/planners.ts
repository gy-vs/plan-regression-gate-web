import type {PlanNode, StatsSnapshot} from '../shared/types';

export type PlannerSide = 'old' | 'new';

export type PlanOutcome =
  | {root: PlanNode; error?: undefined}
  | {root?: undefined; error: {kind: string; message: string}};

const node = (
  op: string,
  table: string | undefined,
  estRows: number | null,
  children: PlanNode[] = [],
): PlanNode => ({op, table, estRows, children});

/**
 * Two deliberately-different fake optimizers. The old optimizer predates the
 * customer_id index and statistics for some columns; the new optimizer uses
 * the catalog and the pinned stats revision.
 */
export function plan(
  side: PlannerSide,
  label: string,
  params: Record<string, string | number | boolean>,
  stats: StatsSnapshot,
): PlanOutcome {
  const orders = stats.rowCounts.orders;
  const customers = stats.rowCounts.customers;
  const sel = (key: string) => stats.selectivity[label]?.[key];

  switch (label) {
    case 'orders_by_customer': {
      if (side === 'old') {
        // Legacy behavior: full scan with a hard-coded guess.
        return {root: node('SeqScan', 'orders', 100_000)};
      }
      const s = sel('orders.customer_id');
      if (s === undefined) return {error: {kind: 'plan_failed', message: 'missing stats for orders.customer_id'}};
      return {root: node('IndexScan', 'orders', Math.round(orders * s))};
    }
    case 'customer_lookup': {
      // Both optimizers agree: pkey point lookup, one row.
      return {root: node('IndexScan', 'customers', 1)};
    }
    case 'slow_report': {
      const s = sel('orders.status') ?? 0.25;
      const est = Math.round(orders * s);
      if (side === 'old') {
        return {root: node('Sort', undefined, est, [node('SeqScan', 'orders', est)])};
      }
      // New optimizer reads an ordered index and drops the sort.
      return {root: node('IndexScan', 'orders', est)};
    }
    case 'adhoc_no_stats': {
      // Neither side has an estimate; shapes happen to match so that the
      // estimate-missing failure is the single cause.
      return {
        root: node('Filter', undefined, null, [node('SeqScan', 'orders', null)]),
      };
    }
    case 'boundary_estimate': {
      // Identical plans and identical (imperfect) estimates on both sides.
      return {root: node('SeqScan', 'orders', 10_000)};
    }
    case 'param_plan_switch': {
      // A bound parameter changes the new optimizer's plan: a selective
      // region gets an index scan, a broad region stays a seq scan. The old
      // optimizer ignores the parameter and always full-scans.
      const s = sel('orders.region');
      if (s === undefined) return {error: {kind: 'plan_failed', message: 'missing stats for orders.region'}};
      const selective = String(params.region) === 'north';
      if (!selective) return {root: node('SeqScan', 'orders', Math.round(orders * s * 10))};
      if (side === 'old') {
        return {root: node('SeqScan', 'orders', Math.round(orders * s * 10))};
      }
      return {root: node('IndexScan', 'orders', Math.round(orders * s))};
    }
    default:
      return {error: {kind: 'unknown_label', message: `no planner rule for label "${label}"`}};
  }
}

/** Structural signature: shape (ops + tables), ignoring estimates. */
export function shapeOf(n: PlanNode | undefined): string {
  if (!n) return '<none>';
  const kids = n.children.map(shapeOf).join(',');
  return `${n.op}${n.table ? `[${n.table}]` : ''}(${kids})`;
}
