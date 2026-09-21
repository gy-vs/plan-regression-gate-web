// Shared domain types for the plan regression gate workbench.

/** A normalized plan tree node (optimizer output, no DB connection needed). */
export type PlanNode = {
  op: string;
  table?: string;
  /** Optimizer estimate; null means the optimizer could not produce one. */
  estRows: number | null;
  children: PlanNode[];
};

/** A saved parameter sample bound to a query label. */
export type Sample = {
  id: string;
  label: string;
  name: string;
  params: Record<string, string | number | boolean>;
};

export type ParameterSet = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  samples: Sample[];
};

export type LabelRule = {
  label: string;
  /** When true, structure changes are allowed for this label. */
  structureChangeAllowed?: boolean;
  /** Per-label override for max acceptable estimated-rows error ratio. */
  maxEstErrorRatio?: number;
};

export type RuleSet = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  /** Global defaults; label entries override them for matching samples. */
  defaults: {
    structureChangeAllowed: boolean;
    maxEstErrorRatio: number;
    measurementTimeoutMs: number;
  };
  labels: LabelRule[];
};

export type StatsSnapshot = {
  revision: number;
  updatedAt: string;
  /** label -> table.column -> selectivity estimate */
  selectivity: Record<string, Record<string, number>>;
  rowCounts: Record<string, number>;
};

export type Measurement = {
  actualRows: number;
  elapsedMs: number;
};

export type CheckName = 'structure' | 'estimated_rows' | 'measurement';

export type CheckResult = {
  name: CheckName;
  passed: boolean;
  /** Human-readable evidence, always present when the check failed. */
  evidence?: string;
  /** Numeric details surfaced for the UI / failure payload. */
  details?: Record<string, number | boolean | string | null>;
};

export type SampleStatus = 'passed' | 'failed' | 'skipped';

/** A single label within a sample outcome. */
export type SampleLabelResult = {
  label: string;
  checks: CheckResult[];
  /** Fatal error for this label (planner/measurement infrastructure failure). */
  error?: {kind: string; message: string};
  oldRoot?: PlanNode;
  newRoot?: PlanNode;
  measurement?: Measurement;
};

export type SampleResult = {
  index: number;
  sampleId: string;
  label: string;
  name: string;
  params: Sample['params'];
  status: SampleStatus;
  labels: SampleLabelResult[];
  /** Error-ratio contribution to the summary; null when not a valid pair. */
  estErrorRatio: number | null;
  /** Valid paired result = both plans present, measurable, estimates known. */
  validPair: boolean;
  /** Set when the sample never ran because the run was cancelled. */
  notRun?: boolean;
};

export type RunSummary = {
  totalSamples: number;
  validPairs: number;
  failedPairs: number;
  passedPairs: number;
  excluded: number;
  notRun: number;
  /** Aggregate computed from valid pairs only. */
  maxEstErrorRatio: number | null;
  passed: boolean;
};

export type RunStatus = 'running' | 'completed' | 'cancelled';

export type GateRun = {
  id: string;
  parameterSetId: string;
  parameterSetRevision: number;
  ruleRevision: number;
  statsRevision: number;
  concurrency: number;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  published: boolean;
  summary: RunSummary | null;
  results: (SampleResult | null)[];
};

export type RunEvent =
  | {type: 'run_started'; runId: string; totalSamples: number}
  | {type: 'sample_started'; runId: string; index: number; sampleId: string}
  | {type: 'sample'; runId: string; result: SampleResult}
  | {type: 'done'; run: GateRun};

export type CatalogInfo = {
  schemaRevision: number;
  tables: {name: string; columns: {name: string; indexed: boolean}[]}[];
  labels: {label: string; description: string}[];
};
