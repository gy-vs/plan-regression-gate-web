import { buildPlan } from './optimizer';
import { effectiveThresholds, evaluateSample, summarize } from './evaluate';
import type { Stores } from './store';
import type {
  GateRun,
  Measurer,
  MeasurerInput,
  Publication,
  QuerySpec,
  RulesSnapshot,
  Sample,
  SampleResult,
  StatsSnapshot,
} from './types';

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(String(body.error ?? status));
  }
}

export interface RunnerOptions {
  measurer?: Measurer;
  measureTimeoutMs?: number;
  concurrency?: number;
  now?: () => string;
}

export type RunEvent =
  | { type: 'sample'; result: SampleResult }
  | { type: 'done'; run: GateRun };

interface RunState {
  run: GateRun;
  query: QuerySpec;
  samples: Sample[];
  stats: StatsSnapshot;
  rules: RulesSnapshot;
  cancelled: boolean;
  nextIndex: number;
  listeners: Set<(event: RunEvent) => void>;
  controllers: Map<number, AbortController>;
  settled: boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject({ code: 'aborted' });
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject({ code: 'aborted' });
    };
    signal?.addEventListener('abort', onAbort);
  });
}

// Default measurement is deterministic and derived from plan cost; tests and
// deployments can inject any other measurer without touching a database.
const defaultMeasurer: Measurer = async ({ plan, signal }) => {
  await sleep(Math.min(15, 2 + plan.root.estCost / 1e7), signal);
  return { runtimeMs: Math.round((50 + plan.root.estCost / 20000) * 100) / 100 };
};

async function measureWithTimeout(
  measurer: Measurer,
  input: MeasurerInput,
  timeoutMs: number,
): Promise<{ runtimeMs: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      measurer(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject({ code: 'measurement_timeout', timeoutMs }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'aborted';
}

function isTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'measurement_timeout'
  );
}

export class GateRunner {
  private runs = new Map<string, RunState>();
  private seq = 0;
  private measurer: Measurer;
  private measureTimeoutMs: number;
  private concurrency: number;
  private now: () => string;

  constructor(
    private stores: Stores,
    options: RunnerOptions = {},
  ) {
    this.measurer = options.measurer ?? defaultMeasurer;
    this.measureTimeoutMs = options.measureTimeoutMs ?? 1000;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(): GateRun[] {
    return [...this.runs.values()].map((s) => this.publicRun(s));
  }

  get(id: string): GateRun | undefined {
    const state = this.runs.get(id);
    return state ? this.publicRun(state) : undefined;
  }

  start(paramSetId: string): GateRun {
    const set = this.stores.paramSets.get(paramSetId);
    if (!set) throw new HttpError(404, { error: 'param_set_not_found', paramSetId });
    // Pin every revisioned input at start time.
    const stats = this.stores.stats.current();
    const rules = this.stores.rules.current();
    const id = `run-${++this.seq}`;
    const run: GateRun = {
      id,
      paramSetId: set.id,
      paramSetRevision: set.revision,
      statsRevision: stats.revision,
      rulesRevision: rules.revision,
      status: 'running',
      createdAt: this.now(),
      samples: set.samples.map((s, index) => ({
        index,
        sampleId: s.id,
        name: s.name,
        labels: set.query.labels,
        status: 'pending' as const,
      })),
    };
    const state: RunState = {
      run,
      query: set.query,
      samples: set.samples,
      stats,
      rules,
      cancelled: false,
      nextIndex: 0,
      listeners: new Set(),
      controllers: new Map(),
      settled: false,
    };
    this.runs.set(id, state);
    void this.execute(state);
    return this.publicRun(state);
  }

  cancel(id: string): GateRun {
    const state = this.mustGet(id);
    if (state.run.status === 'running') {
      state.cancelled = true;
      for (const controller of state.controllers.values()) controller.abort();
    }
    return this.publicRun(state);
  }

  publish(id: string): Publication {
    const state = this.mustGet(id);
    const run = state.run;
    if (run.status !== 'completed') {
      throw new HttpError(409, { error: 'run_not_completed', status: run.status });
    }
    const rules = this.stores.rules.current();
    if (run.rulesRevision !== rules.revision) {
      // A run evaluated under old rules must never be published onto a newer
      // rules revision; it has to be re-run first.
      throw new HttpError(409, {
        error: 'stale_rules_revision',
        runRulesRevision: run.rulesRevision,
        currentRulesRevision: rules.revision,
      });
    }
    run.publishedAt = this.now();
    return {
      runId: run.id,
      paramSetId: run.paramSetId,
      decision: run.decision,
      publishedAt: run.publishedAt,
      revisions: {
        paramSet: run.paramSetRevision,
        stats: run.statsRevision,
        rules: run.rulesRevision,
      },
    };
  }

  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    const state = this.mustGet(id);
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  private mustGet(id: string): RunState {
    const state = this.runs.get(id);
    if (!state) throw new HttpError(404, { error: 'run_not_found', runId: id });
    return state;
  }

  private publicRun(state: RunState): GateRun {
    return structuredClone(state.run);
  }

  private emit(state: RunState, event: RunEvent): void {
    for (const listener of state.listeners) listener(event);
  }

  private async execute(state: RunState): Promise<void> {
    const workerCount = Math.min(this.concurrency, state.samples.length);
    const workers = Array.from({ length: workerCount }, () => this.worker(state));
    await Promise.all(workers);
    this.finalize(state);
  }

  private async worker(state: RunState): Promise<void> {
    while (!state.cancelled) {
      const index = state.nextIndex;
      state.nextIndex += 1;
      if (index >= state.samples.length) return;
      await this.runSample(state, index);
    }
  }

  private async runSample(state: RunState, index: number): Promise<void> {
    const result = state.run.samples[index];
    const sample = state.samples[index];
    result.status = 'running';
    this.emit(state, { type: 'sample', result: structuredClone(result) });
    const controller = new AbortController();
    state.controllers.set(index, controller);
    try {
      const legacyPlan = buildPlan(state.query, sample.params, state.stats, 'legacy');
      const newPlan = buildPlan(state.query, sample.params, state.stats, 'new');
      const [legacyMs, newMs] = await Promise.all([
        measureWithTimeout(
          this.measurer,
          { plan: legacyPlan, sample, query: state.query, signal: controller.signal },
          this.measureTimeoutMs,
        ),
        measureWithTimeout(
          this.measurer,
          { plan: newPlan, sample, query: state.query, signal: controller.signal },
          this.measureTimeoutMs,
        ),
      ]);
      const { thresholds, applied } = effectiveThresholds(state.rules, state.query.labels);
      const evaluation = evaluateSample({
        legacyRoot: legacyPlan.root,
        newRoot: newPlan.root,
        legacyMs: legacyMs.runtimeMs,
        newMs: newMs.runtimeMs,
        thresholds,
      });
      result.status = evaluation.status;
      result.checks = evaluation.checks;
      result.maxEstError = evaluation.maxEstError;
      result.runtimeRatio = evaluation.runtimeRatio;
      result.structuralDiffCount = evaluation.structuralDiffCount;
      if (applied.length > 0) result.appliedOverrides = applied;
    } catch (err) {
      if (isAbort(err)) {
        // Cancelled while in flight: this sample never produced a verdict, so
        // it is "not run" rather than failed.
        result.status = 'skipped';
        result.reason = { type: 'cancelled' };
      } else if (isTimeout(err)) {
        result.status = 'invalid';
        result.reason = { type: 'measurement_timeout', timeoutMs: this.measureTimeoutMs };
      } else {
        result.status = 'invalid';
        result.reason = {
          type: 'plan_error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      state.controllers.delete(index);
    }
    this.emit(state, { type: 'sample', result: structuredClone(result) });
  }

  private finalize(state: RunState): void {
    if (state.settled) return;
    state.settled = true;
    for (const result of state.run.samples) {
      if (result.status === 'pending' || result.status === 'running') {
        result.status = 'skipped';
        result.reason = { type: 'cancelled' };
      }
    }
    state.run.summary = summarize(state.run.samples);
    if (state.cancelled) {
      state.run.status = 'cancelled';
    } else {
      state.run.status = 'completed';
      state.run.decision =
        state.run.summary.failed > 0 || state.run.summary.invalid > 0 ? 'failed' : 'passed';
    }
    state.run.finishedAt = this.now();
    this.emit(state, { type: 'done', run: this.publicRun(state) });
  }
}
