import {shapeOf, type PlannerSide, plan} from './planners';
import {
  MeasurementTimeoutError,
  runWithTimeout,
  type MeasureFn,
} from './measurement';
import type {
  CheckResult,
  LabelRule,
  Measurement,
  PlanNode,
  RuleSet,
  Sample,
  SampleLabelResult,
  StatsSnapshot,
} from '../shared/types';

/** Resolve the effective rule for a label: label override over defaults. */
export function effectiveRule(rules: RuleSet, label: string): Required<LabelRule> & {measurementTimeoutMs: number} {
  const override = rules.labels.find((entry) => entry.label === label);
  return {
    label,
    structureChangeAllowed: override?.structureChangeAllowed ?? rules.defaults.structureChangeAllowed,
    maxEstErrorRatio: override?.maxEstErrorRatio ?? rules.defaults.maxEstErrorRatio,
    measurementTimeoutMs: rules.defaults.measurementTimeoutMs,
  };
}

export function structureCheck(oldRoot: PlanNode | undefined, newRoot: PlanNode | undefined, allowed: boolean): CheckResult {
  const same = shapeOf(oldRoot) === shapeOf(newRoot);
  if (same) return {name: 'structure', passed: true};
  return {
    name: 'structure',
    passed: allowed,
    evidence: allowed
      ? undefined
      : `plan shape changed: ${shapeOf(oldRoot)} -> ${shapeOf(newRoot)}`,
    details: {oldShape: shapeOf(oldRoot), newShape: shapeOf(newRoot), allowed},
  };
}

/**
 * New-side estimate error |est-actual|/actual; null when the new estimate
 * is missing. The old estimate is never averaged in: a better new estimate
 * must not be blocked just because the legacy planner guessed badly.
 */
export function estimateErrorRatio(
  _oldRoot: PlanNode | undefined,
  newRoot: PlanNode | undefined,
  actualRows: number,
): number | null {
  if (newRoot?.estRows == null) return null;
  return Math.abs(newRoot.estRows - actualRows) / actualRows;
}

function oldErrorRatio(oldRoot: PlanNode | undefined, actualRows: number): number | null {
  if (oldRoot?.estRows == null) return null;
  return Math.abs(oldRoot.estRows - actualRows) / actualRows;
}

function estimateCheck(
  oldRoot: PlanNode | undefined,
  newRoot: PlanNode | undefined,
  measurement: Measurement | undefined,
  threshold: number,
): {check: CheckResult; ratio: number | null; validPair: boolean} {
  if (oldRoot?.estRows == null || newRoot?.estRows == null) {
    const missingSide = oldRoot?.estRows == null ? (newRoot?.estRows == null ? 'old and new' : 'old') : 'new';
    return {
      check: {
        name: 'estimated_rows',
        passed: false,
        evidence: `estimated rows missing on ${missingSide} planner; cannot compute error ratio`,
        details: {oldEst: oldRoot?.estRows ?? -1, newEst: newRoot?.estRows ?? -1, threshold},
      },
      // Missing estimate means there is no valid numeric pair for the summary.
      ratio: null,
      validPair: false,
    };
  }
  if (!measurement) {
    return {
      check: {
        name: 'estimated_rows',
        passed: false,
        evidence: 'no measurement available for error-ratio comparison',
      },
      ratio: null,
      validPair: false,
    };
  }
  const ratio = estimateErrorRatio(oldRoot, newRoot, measurement.actualRows)!;
  const oldRatio = oldErrorRatio(oldRoot, measurement.actualRows);
  // Boundary is inclusive: ratio exactly at the threshold passes.
  const passed = ratio <= threshold;
  return {
    check: {
      name: 'estimated_rows',
      passed,
      evidence: passed
        ? undefined
        : `new est error ratio ${ratio.toFixed(4)} exceeds threshold ${threshold} (old est ${oldRoot.estRows}${oldRatio == null ? '' : `, old ratio ${oldRatio.toFixed(4)}`}, new est ${newRoot.estRows}, actual ${measurement.actualRows})`,
      details: {
        ratio: Number(ratio.toFixed(6)),
        oldRatio: oldRatio == null ? null : Number(oldRatio.toFixed(6)),
        threshold,
        oldEst: oldRoot.estRows,
        newEst: newRoot.estRows,
        actualRows: measurement.actualRows,
      },
    },
    ratio,
    validPair: true,
  };
}

export type EvaluateOptions = {
  rules: RuleSet;
  stats: StatsSnapshot;
  measure: MeasureFn;
  /** When false, skip the measurement pass (estimate check becomes invalid). */
  enableMeasurement: boolean;
  signal?: AbortSignal;
};

/**
 * Evaluate one sample across both planners. A planner/measurement failure is
 * reported as a label-level error; partial failures (one label fails, others
 * pass) still yield per-label evidence.
 */
export async function evaluateSample(
  sample: Sample,
  index: number,
  options: EvaluateOptions,
): Promise<{result: import('../shared/types').SampleResult}> {
  const rule = effectiveRule(options.rules, sample.label);
  const labels: SampleLabelResult[] = [];

  let oldRoot: PlanNode | undefined;
  let newRoot: PlanNode | undefined;
  let measurement: Measurement | undefined;
  let labelError: SampleLabelResult['error'];

  const oldOutcome = plan('old' as PlannerSide, sample.label, sample.params, options.stats);
  const newOutcome = plan('new' as PlannerSide, sample.label, sample.params, options.stats);
  oldRoot = oldOutcome.root;
  newRoot = newOutcome.root;
  if (oldOutcome.error || newOutcome.error) {
    labelError = newOutcome.error ?? oldOutcome.error;
  }

  if (!labelError && options.enableMeasurement && newRoot) {
    try {
      measurement = await runWithTimeout(options.measure, newRoot, {
        side: 'new',
        label: sample.label,
        sample,
        statsRevision: options.stats.revision,
        signal: options.signal ?? new AbortController().signal,
      }, rule.measurementTimeoutMs);
    } catch (err) {
      // Cancellation while a measurement is in flight: propagate so the
      // runner records the sample as not-run rather than failed.
      if (options.signal?.aborted) throw err;
      if (err instanceof MeasurementTimeoutError) {
        labelError = {kind: err.kind, message: err.message};
      } else {
        labelError = {kind: 'measurement_failed', message: err instanceof Error ? err.message : String(err)};
      }
    }
  }

  const checks: CheckResult[] = [];
  let validPair = false;
  let ratio: number | null = null;

  if (labelError) {
    labels.push({
      label: sample.label,
      checks: [],
      error: labelError,
      oldRoot,
      newRoot,
      measurement,
    });
  } else {
    checks.push(structureCheck(oldRoot, newRoot, rule.structureChangeAllowed));
    const estimate = estimateCheck(oldRoot, newRoot, measurement, rule.maxEstErrorRatio);
    checks.push(estimate.check);
    ratio = estimate.ratio;
    validPair = estimate.validPair;
    if (options.enableMeasurement) {
      checks.push({
        name: 'measurement',
        passed: measurement !== undefined,
        evidence: measurement ? undefined : 'measurement was not produced',
      });
    }
    labels.push({label: sample.label, checks, oldRoot, newRoot, measurement});
  }

  const failed =
    labelError !== undefined || checks.some((check) => !check.passed);

  return {
    result: {
      index,
      sampleId: sample.id,
      label: sample.label,
      name: sample.name,
      params: sample.params,
      status: failed ? 'failed' : 'passed',
      labels,
      estErrorRatio: validPair ? ratio : null,
      validPair,
    },
  };
}
