import type {
  ParamSet,
  QuerySpec,
  RulesSnapshot,
  Sample,
  StatsSnapshot,
  TableStats,
  Thresholds,
} from './types';

export class ParamSetStore {
  private sets = new Map<string, ParamSet>();

  constructor(seed: ParamSet[]) {
    seed.forEach((s) => this.sets.set(s.id, structuredClone(s)));
  }

  list(): ParamSet[] {
    return [...this.sets.values()].map((s) => structuredClone(s));
  }

  get(id: string): ParamSet | undefined {
    const found = this.sets.get(id);
    return found ? structuredClone(found) : undefined;
  }

  create(input: { id?: string; name: string; query: QuerySpec; samples: Sample[] }): ParamSet {
    const id = input.id ?? `set-${this.sets.size + 1}`;
    if (this.sets.has(id)) throw new Error(`duplicate_param_set:${id}`);
    const set: ParamSet = {
      id,
      name: input.name,
      query: input.query,
      samples: input.samples,
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
    this.sets.set(id, set);
    return structuredClone(set);
  }

  update(
    id: string,
    revision: number,
    patch: { name?: string; query?: QuerySpec; samples?: Sample[] },
  ):
    | { status: 'ok'; set: ParamSet }
    | { status: 'conflict'; current: ParamSet }
    | { status: 'missing' } {
    const current = this.sets.get(id);
    if (!current) return { status: 'missing' };
    if (current.revision !== revision) {
      return { status: 'conflict', current: structuredClone(current) };
    }
    const next: ParamSet = {
      ...current,
      name: patch.name ?? current.name,
      query: patch.query ?? current.query,
      samples: patch.samples ?? current.samples,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.sets.set(id, next);
    return { status: 'ok', set: structuredClone(next) };
  }
}

// Stats and rules are versioned; every revision is retained so a gate run can
// pin the exact snapshots it started with.
class VersionedStore<T extends { revision: number; updatedAt: string }> {
  private history = new Map<number, T>();
  private head: number;

  constructor(initial: T) {
    this.history.set(initial.revision, structuredClone(initial));
    this.head = initial.revision;
  }

  current(): T {
    return structuredClone(this.history.get(this.head)!);
  }

  at(revision: number): T | undefined {
    const found = this.history.get(revision);
    return found ? structuredClone(found) : undefined;
  }

  commit(
    revision: number,
    build: (next: T) => T,
  ): { status: 'ok'; snapshot: T } | { status: 'conflict'; current: T } {
    if (revision !== this.head) {
      return { status: 'conflict', current: this.current() };
    }
    const next = build(this.current());
    next.revision = this.head + 1;
    next.updatedAt = new Date().toISOString();
    this.history.set(next.revision, structuredClone(next));
    this.head = next.revision;
    return { status: 'ok', snapshot: structuredClone(next) };
  }
}

export type StatsStore = VersionedStore<StatsSnapshot>;
export type RulesStore = VersionedStore<RulesSnapshot>;

export interface Stores {
  paramSets: ParamSetStore;
  stats: StatsStore;
  rules: RulesStore;
}

export function seedStats(): StatsSnapshot {
  return {
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    tables: {
      orders: {
        rowCount: 100000,
        columns: {
          status: { ndv: 4 },
          amount: { histogram: [10, 50, 100, 500, 1000, 5000] },
          customer_id: { ndv: 5000 },
          item_id: { ndv: 20000 },
        },
      },
      customers: {
        rowCount: 5000,
        columns: { id: { ndv: 5000 }, region: { ndv: 8 } },
      },
      items: {
        rowCount: 20000,
        columns: { id: { ndv: 20000 }, sku: { ndv: 18000 } },
      },
    },
  };
}

export function seedRules(): RulesSnapshot {
  return {
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    defaults: { maxStructuralDiff: 0, maxEstError: 0.25, maxRuntimeRatio: 3 },
    overrides: {
      oltp: { maxStructuralDiff: 2 },
      bulk: { maxEstError: 1 },
    },
  };
}

export function seedParamSets(): ParamSet[] {
  const at = new Date(0).toISOString();
  return [
    {
      id: 'alpha',
      name: '订单查询（按状态与金额）',
      query: {
        base: 'orders',
        joins: [{ table: 'customers', column: 'id', refTable: 'orders', refColumn: 'customer_id' }],
        filters: [
          { table: 'orders', column: 'status', op: 'eq', param: 'status' },
          { table: 'orders', column: 'amount', op: 'gt', param: 'minAmount' },
        ],
        labels: ['oltp'],
      },
      samples: [
        { id: 'a1', name: '小额已支付', params: { status: 'paid', minAmount: 5 } },
        { id: 'a2', name: '中额订单', params: { status: 'paid', minAmount: 450 } },
        { id: 'a3', name: '高额订单', params: { status: 'paid', minAmount: 975 } },
        { id: 'a4', name: '跨直方图分桶', params: { status: 'paid', minAmount: 1001 } },
      ],
      revision: 1,
      updatedAt: at,
    },
    {
      id: 'beta',
      name: '订单明细（双关联）',
      query: {
        base: 'orders',
        joins: [
          { table: 'customers', column: 'id', refTable: 'orders', refColumn: 'customer_id' },
          { table: 'items', column: 'id', refTable: 'orders', refColumn: 'item_id' },
        ],
        filters: [{ table: 'items', column: 'sku', op: 'eq', param: 'sku' }],
        labels: ['bulk'],
      },
      samples: [
        { id: 'b1', name: 'SKU A-1', params: { sku: 'A-1' } },
        { id: 'b2', name: 'SKU B-2', params: { sku: 'B-2' } },
      ],
      revision: 1,
      updatedAt: at,
    },
  ];
}

export function createStores(): Stores {
  return {
    paramSets: new ParamSetStore(seedParamSets()),
    stats: new VersionedStore(seedStats()),
    rules: new VersionedStore(seedRules()),
  };
}

export function isValidThresholds(value: unknown): value is Thresholds {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.maxStructuralDiff === 'number' &&
    typeof t.maxEstError === 'number' &&
    typeof t.maxRuntimeRatio === 'number'
  );
}

export function isValidTableStatsMap(value: unknown): value is Record<string, TableStats> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, TableStats>).every(
    (t) => typeof t === 'object' && t !== null && typeof t.rowCount === 'number' && typeof t.columns === 'object',
  );
}
