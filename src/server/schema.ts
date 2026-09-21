import type {CatalogInfo, StatsSnapshot} from '../shared/types';

/**
 * The server pins a fixed schema. It never changes for the lifetime of the
 * process; only statistics carry a mutable revision.
 */
export const SCHEMA_REVISION = 1;

export const CATALOG: CatalogInfo = {
  schemaRevision: SCHEMA_REVISION,
  tables: [
    {
      name: 'orders',
      columns: [
        {name: 'id', indexed: true},
        {name: 'customer_id', indexed: true},
        {name: 'status', indexed: false},
      ],
    },
    {
      name: 'customers',
      columns: [
        {name: 'id', indexed: true},
        {name: 'segment', indexed: true},
      ],
    },
  ],
  labels: [
    {label: 'orders_by_customer', description: 'Orders filtered by customer_id'},
    {label: 'customer_lookup', description: 'Single-row customers lookup'},
    {label: 'slow_report', description: 'Orders report with sort'},
    {label: 'adhoc_no_stats', description: 'Ad-hoc query over a column without stats'},
    {label: 'boundary_estimate', description: 'Estimate error ratio threshold probe'},
    {label: 'param_plan_switch', description: 'Plan shape depends on a bound parameter'},
  ],
};

export function initialStats(): StatsSnapshot {
  return {
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    rowCounts: {orders: 1_000_000, customers: 50_000},
    selectivity: {
      orders_by_customer: {'orders.customer_id': 0.001},
      customer_lookup: {'customers.id': 0.00002},
      slow_report: {'orders.status': 0.25},
      adhoc_no_stats: {'orders.status': 0.25},
      param_plan_switch: {'orders.region': 0.01},
      // boundary_estimate is intentionally absent: the old optimizer has no
      // column statistic for it either.
    },
  };
}
