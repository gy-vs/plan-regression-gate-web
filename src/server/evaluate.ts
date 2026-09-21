import type {
  CheckResult,
  PlanNode,
  RulesSnapshot,
  RunSummary,
  SampleResult,
  Thresholds,
} from './types';

export function labelOf(n: PlanNode): string {
  return n.children.length === 0 ? `${n.op}:${n.table ?? '?'}` : `${n.op}>${n.table ?? '?'}`;
}

export function planLabels(root: PlanNode): string[] {
  const out: string[] = [];
  const walk = (n: PlanNode) => {
    out.push(labelOf(n));
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

export interface StructuralDiff {
  count: number;
  diffs: { index: number; legacy: string; current: string }[];
}

export function structuralDiff(legacy: PlanNode, current: PlanNode): StructuralDiff {
  const a = planLabels(legacy);
  const b = planLabels(current);
  const diffs: StructuralDiff['diffs'] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? '<none>';
    const y = b[i] ?? '<none>';
    if (x !== y) diffs.push({ index: i, legacy: x, current: y });
  }
  return { count: diffs.length, diffs };
}

export interface EstimationAudit {
  maxError: number | null;
  worst?: { node: string; estRows: number; actualRows: number; error: number };
  missing?: { node: string; reason: 'missing_estimate' | 'missing_actual' };
}

export function auditEstimation(root: PlanNode): EstimationAudit {
  let max: number | null = null;
  let worst: EstimationAudit['worst'];
  let missing: EstimationAudit['missing'];
  const walk = (n: PlanNode) => {
    if (missing) return;
    if (n.estRows === null) {
      missing = { node: labelOf(n), reason: 'missing_estimate' };
      return;
    }
    if (n.actualRows === null) {
      missing = { node: labelOf(n), reason: 'missing_actual' };
      return;
    }
    const error = Math.abs(n.estRows - n.actualRows) / Math.max(n.actualRows, 1);
    if (max === null || error > max) {
      max = error;
      worst = { node: labelOf(n), estRows: n.estRows, actualRows: n.actualRows, error };
    }
    n.children.forEach(walk);
  };
  walk(root);
  return { maxError: max, worst, missing };
}

export interface EvaluationInput {
  legacyRoot: PlanNode;
  newRoot: PlanNode;
  legacyMs: number;
  newMs: number;
  thresholds: Thresholds;
}

export interface Evaluation {
  status: 'passed' | 'failed';
  checks: CheckResult[];
  maxEstError: number | null;
  runtimeRatio: number;
  structuralDiffCount: number;
}

// Thresholds are inclusive: a value exactly at the limit passes.
export function evaluateSample(input: EvaluationInput): Evaluation {
  const checks: CheckResult[] = [];
  const diff = structuralDiff(input.legacyRoot, input.newRoot);
  checks.push(
    diff.count <= input.thresholds.maxStructuralDiff
      ? { name: 'structure', status: 'pass' }
      : {
          name: 'structure',
          status: 'fail',
          evidence: {
            diffCount: diff.count,
            threshold: input.thresholds.maxStructuralDiff,
            diffs: diff.diffs,
          },
        },
  );
  const audit = auditEstimation(input.newRoot);
  if (audit.missing) {
    checks.push({
      name: 'estimation',
      status: 'fail',
      evidence: {
        reason: audit.missing.reason,
        node: audit.missing.node,
        threshold: input.thresholds.maxEstError,
      },
    });
  } else if (audit.maxError !== null && audit.maxError > input.thresholds.maxEstError) {
    checks.push({
      name: 'estimation',
      status: 'fail',
      evidence: { ...audit.worst, threshold: input.thresholds.maxEstError },
    });
  } else {
    checks.push({ name: 'estimation', status: 'pass' });
  }
  const ratio = input.newMs / Math.max(input.legacyMs, 1);
  checks.push(
    ratio <= input.thresholds.maxRuntimeRatio
      ? { name: 'measurement', status: 'pass' }
      : {
          name: 'measurement',
          status: 'fail',
          evidence: {
            legacyMs: input.legacyMs,
            newMs: input.newMs,
            ratio,
            threshold: input.thresholds.maxRuntimeRatio,
          },
        },
  );
  return {
    status: checks.every((c) => c.status === 'pass') ? 'passed' : 'failed',
    checks,
    maxEstError: audit.maxError,
    runtimeRatio: ratio,
    structuralDiffCount: diff.count,
  };
}

export function effectiveThresholds(
  rules: Pick<RulesSnapshot, 'defaults' | 'overrides'>,
  labels: string[],
): { thresholds: Thresholds; applied: string[] } {
  const thresholds: Thresholds = { ...rules.defaults };
  const applied: string[] = [];
  for (const label of labels) {
    const override = rules.overrides[label];
    if (!override) continue;
    applied.push(label);
    for (const key of ['maxStructuralDiff', 'maxEstError', 'maxRuntimeRatio'] as const) {
      const value = override[key];
      if (typeof value === 'number') thresholds[key] = value;
    }
  }
  return { thresholds, applied };
}

// Aggregates are computed over valid pairs only: samples where both optimizers
// produced a plan and both measurements completed (passed or failed).
export function summarize(results: SampleResult[]): RunSummary {
  const valid = results.filter((r) => r.status === 'passed' || r.status === 'failed');
  const maxOf = (values: (number | null | undefined)[]): number | null => {
    const nums = values.filter((v): v is number => typeof v === 'number');
    return nums.length > 0 ? Math.max(...nums) : null;
  };
  return {
    total: results.length,
    validPairs: valid.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    invalid: results.filter((r) => r.status === 'invalid').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    structuralChanges: valid.filter((r) => (r.structuralDiffCount ?? 0) > 0).length,
    maxEstError: maxOf(valid.map((r) => r.maxEstError)),
    maxRuntimeRatio: maxOf(valid.map((r) => r.runtimeRatio)),
  };
}
