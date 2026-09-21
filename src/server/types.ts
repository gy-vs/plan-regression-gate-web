// Domain types for the plan regression gate workbench.

export type FilterOp = 'eq' | 'gt' | 'lt';

export interface QueryFilter {
  table: string;
  column: string;
  op: FilterOp;
  param: string;
}

export interface JoinSpec {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export interface QuerySpec {
  base: string;
  joins: JoinSpec[];
  filters: QueryFilter[];
  labels: string[];
}

export interface Sample {
  id: string;
  name: string;
  params: Record<string, number | string>;
}

export interface ParamSet {
  id: string;
  name: string;
  query: QuerySpec;
  samples: Sample[];
  revision: number;
  updatedAt: string;
}

export interface ColumnStats {
  ndv?: number;
  histogram?: number[];
}

export interface TableStats {
  rowCount: number;
  columns: Record<string, ColumnStats>;
}

export interface StatsSnapshot {
  revision: number;
  tables: Record<string, TableStats>;
  updatedAt: string;
}

export interface Thresholds {
  maxStructuralDiff: number;
  maxEstError: number;
  maxRuntimeRatio: number;
}

export interface RulesSnapshot {
  revision: number;
  defaults: Thresholds;
  overrides: Record<string, Partial<Thresholds>>;
  updatedAt: string;
}

export interface PlanNode {
  id: string;
  op: string;
  table?: string;
  estRows: number | null;
  actualRows: number | null;
  estCost: number;
  children: PlanNode[];
}

export interface Plan {
  optimizer: 'legacy' | 'new';
  root: PlanNode;
}

export interface Measurement {
  runtimeMs: number;
}

export interface MeasurerInput {
  plan: Plan;
  sample: Sample;
  query: QuerySpec;
  signal: AbortSignal;
}

export type Measurer = (input: MeasurerInput) => Promise<Measurement>;

export interface CheckResult {
  name: 'structure' | 'estimation' | 'measurement';
  status: 'pass' | 'fail';
  evidence?: Record<string, unknown>;
}

export type SampleStatus = 'pending' | 'running' | 'passed' | 'failed' | 'invalid' | 'skipped';

export interface SampleResult {
  index: number;
  sampleId: string;
  name: string;
  labels: string[];
  status: SampleStatus;
  checks?: CheckResult[];
  reason?: Record<string, unknown>;
  appliedOverrides?: string[];
  maxEstError?: number | null;
  runtimeRatio?: number;
  structuralDiffCount?: number;
}

export interface RunSummary {
  total: number;
  validPairs: number;
  passed: number;
  failed: number;
  invalid: number;
  skipped: number;
  structuralChanges: number;
  maxEstError: number | null;
  maxRuntimeRatio: number | null;
}

export interface GateRun {
  id: string;
  paramSetId: string;
  paramSetRevision: number;
  statsRevision: number;
  rulesRevision: number;
  status: 'running' | 'completed' | 'cancelled';
  decision?: 'passed' | 'failed';
  samples: SampleResult[];
  summary?: RunSummary;
  createdAt: string;
  finishedAt?: string;
  publishedAt?: string;
}

export interface Publication {
  runId: string;
  paramSetId: string;
  decision?: 'passed' | 'failed';
  publishedAt: string;
  revisions: { paramSet: number; stats: number; rules: number };
}
