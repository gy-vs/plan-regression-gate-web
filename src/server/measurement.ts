import type {Measurement, PlanNode, Sample} from '../shared/types';

export class MeasurementTimeoutError extends Error {
  readonly kind = 'measurement_timeout';
  constructor(readonly timeoutMs: number) {
    super(`measurement exceeded ${timeoutMs}ms`);
  }
}

export type MeasureContext = {
  side: 'old' | 'new';
  label: string;
  sample: Sample;
  statsRevision: number;
  signal: AbortSignal;
};

export type MeasureFn = (
  root: PlanNode,
  ctx: MeasureContext,
) => Promise<Measurement>;

/**
 * Default "executor". No real database is involved: actual rows are derived
 * from the plan/label, and some labels deliberately run slowly so timeout
 * handling can be exercised end to end.
 */
export const defaultMeasure: MeasureFn = async (_root, ctx) => {
  const delay = Number(ctx.sample.params.delayMs ?? 0);
  if (delay > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        {once: true},
      );
    });
  }
  switch (ctx.label) {
    case 'orders_by_customer':
      return {actualRows: 1_000, elapsedMs: delay};
    case 'customer_lookup':
      return {actualRows: 1, elapsedMs: delay};
    case 'slow_report':
      return {actualRows: 250_000, elapsedMs: delay};
    case 'adhoc_no_stats':
      return {actualRows: 250_000, elapsedMs: delay};
    case 'boundary_estimate':
      return {actualRows: Number(ctx.sample.params.actualRows ?? 10_000), elapsedMs: delay};
    case 'param_plan_switch':
      return {actualRows: ctx.sample.params.region === 'north' ? 10_000 : 100_000, elapsedMs: delay};
    default:
      return {actualRows: 1, elapsedMs: delay};
  }
};

/** Race the injected measurement against the per-run timeout. */
export async function runWithTimeout(
  measure: MeasureFn,
  root: PlanNode,
  ctx: MeasureContext,
  timeoutMs: number,
): Promise<Measurement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      measure(root, ctx),
      new Promise<Measurement>((_, reject) => {
        timer = setTimeout(() => reject(new MeasurementTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
