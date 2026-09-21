import type {
  GateRun,
  ParameterSet,
  RuleSet,
  RunEvent,
  SampleResult,
} from '../shared/types';
import {defaultMeasure, type MeasureFn} from './measurement';
import {evaluateSample} from './gate';

export type RunnerDeps = {
  measure: MeasureFn;
  enableMeasurement: boolean;
  concurrency: number;
  onEvent: (event: RunEvent) => void;
};

type RunInternal = GateRun & {
  abort: AbortController;
  /** sample indices that have been claimed by a worker. */
  claimed: boolean[];
};

/**
 * Concurrency-limited runner. Samples execute independently (one planner
 * invocation + one measurement each). Results are buffered into their
 * original index so consumers always see sample order, even though the
 * events stream as work finishes.
 */
export class RunManager {
  private runs = new Map<string, RunInternal>();
  /** Gate ids that currently hold an execution slot. */
  private active = new Set<string>();
  private maxConcurrentRuns: number;

  constructor(maxConcurrentRuns = 2) {
    this.maxConcurrentRuns = maxConcurrentRuns;
  }

  hasCapacity(): boolean {
    return this.active.size < this.maxConcurrentRuns;
  }

  activeCount(): number {
    return this.active.size;
  }

  get(id: string): GateRun | undefined {
    const run = this.runs.get(id);
    return run ? this.strip(run) : undefined;
  }

  /** Mark the stored run (not an ephemeral copy) as published. */
  markPublished(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    run.published = true;
    return true;
  }

  list(): GateRun[] {
    return [...this.runs.values()].map((run) => this.strip(run));
  }

  /**
   * Start a run. Returns 'capacity' when two gates are already executing.
   * Snapshots of parameter set / rules / stats revision are taken now and
   * pinned to the run for its whole lifetime.
   */
  start(
    id: string,
    snapshot: {
      parameterSetId: string;
      parameterSetRevision: number;
      ruleRevision: number;
      statsRevision: number;
      samples: ParameterSet['samples'];
      rules: RuleSet;
      stats: import('../shared/types').StatsSnapshot;
    },
    deps: RunnerDeps,
  ): GateRun | {error: 'capacity'} {
    if (!this.hasCapacity()) return {error: 'capacity'};

    const abort = new AbortController();
    const total = snapshot.samples.length;
    const run: RunInternal = {
      id,
      parameterSetId: snapshot.parameterSetId,
      parameterSetRevision: snapshot.parameterSetRevision,
      ruleRevision: snapshot.ruleRevision,
      statsRevision: snapshot.statsRevision,
      concurrency: deps.concurrency,
      status: 'running',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      published: false,
      summary: null,
      results: new Array(total).fill(null),
      abort,
      claimed: new Array(total).fill(false),
    };
    this.runs.set(id, run);
    this.active.add(id);

    void this.execute(run, snapshot.samples, snapshot.rules, snapshot.stats, deps);
    return this.strip(run);
  }

  /** Cancel: in-flight samples abort; unclaimed samples never run. */
  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running') return false;
    run.abort.abort();
    return true;
  }

  private async execute(
    run: RunInternal,
    samples: ParameterSet['samples'],
    rules: RuleSet,
    stats: import('../shared/types').StatsSnapshot,
    deps: RunnerDeps,
  ) {
    deps.onEvent({type: 'run_started', runId: run.id, totalSamples: samples.length});

    let next = 0;
    let cancelled = false;

    const worker = async () => {
      for (;;) {
        if (run.abort.signal.aborted) {
          cancelled = true;
          return;
        }
        const index = next++;
        if (index >= samples.length) return;
        run.claimed[index] = true;

        deps.onEvent({type: 'sample_started', runId: run.id, index, sampleId: samples[index].id});

        if (run.abort.signal.aborted) {
          // Claimed but not actually executed: record as not-run, distinct
          // from a failure.
          cancelled = true;
          this.recordNotRun(run, index, samples[index], deps);
          continue;
        }

        let result: SampleResult;
        try {
          result = (
            await evaluateSample(samples[index], index, {
              rules,
              stats,
              measure: deps.measure,
              enableMeasurement: deps.enableMeasurement,
              signal: run.abort.signal,
            })
          ).result;
        } catch (err) {
          if (run.abort.signal.aborted) {
            cancelled = true;
            this.recordNotRun(run, index, samples[index], deps);
            continue;
          }
          result = {
            index,
            sampleId: samples[index].id,
            label: samples[index].label,
            name: samples[index].name,
            params: samples[index].params,
            status: 'failed',
            labels: [
              {
                label: samples[index].label,
                checks: [],
                error: {kind: 'sample_crashed', message: err instanceof Error ? err.message : String(err)},
              },
            ],
            estErrorRatio: null,
            validPair: false,
          };
        }

        run.results[index] = result;
        deps.onEvent({type: 'sample', runId: run.id, result});
      }
    };

    await Promise.all(
      Array.from({length: Math.min(deps.concurrency, samples.length)}, () => worker()),
    );

    // Unclaimed samples (cancellation with more samples than workers got to)
    // are recorded as not-run in their original slots.
    for (let i = 0; i < samples.length; i += 1) {
      if (run.results[i] === null) {
        this.recordNotRun(run, i, samples[i], deps, /*silent*/ true);
      }
    }

    run.status = cancelled || run.abort.signal.aborted ? 'cancelled' : 'completed';
    run.finishedAt = new Date().toISOString();
    run.summary = summarize(run);
    this.active.delete(run.id);
    deps.onEvent({type: 'done', run: this.strip(run)});
  }

  private recordNotRun(
    run: RunInternal,
    index: number,
    sample: ParameterSet['samples'][number],
    deps: RunnerDeps,
    silent = false,
  ) {
    const result: SampleResult = {
      index,
      sampleId: sample.id,
      label: sample.label,
      name: sample.name,
      params: sample.params,
      status: 'skipped',
      labels: [],
      estErrorRatio: null,
      validPair: false,
      notRun: true,
    };
    run.results[index] = result;
    if (!silent) deps.onEvent({type: 'sample', runId: run.id, result});
  }

  private strip(run: RunInternal): GateRun {
    const {abort: _abort, claimed: _claimed, ...rest} = run;
    return rest;
  }
}

/**
 * Summary uses valid paired results only: both plans produced, measurement
 * available, and both estimates present. Failed/invalid pairs are excluded
 * from the aggregate but counted so the gate still fails.
 */
export function summarize(run: GateRun): import('../shared/types').RunSummary {
  const results = run.results.filter((r): r is SampleResult => r !== null);
  const valid = results.filter((r) => r.validPair && !r.notRun);
  const ratios = valid
    .map((r) => r.estErrorRatio)
    .filter((v): v is number => v !== null);

  return {
    totalSamples: run.results.length,
    validPairs: valid.length,
    failedPairs: results.filter((r) => r.status === 'failed').length,
    passedPairs: results.filter((r) => r.status === 'passed').length,
    excluded: results.filter((r) => !r.validPair && !r.notRun).length,
    notRun: results.filter((r) => r.notRun).length,
    maxEstErrorRatio: ratios.length ? Math.max(...ratios) : null,
    // Gate passes only when every sample passed and nothing was skipped.
    passed:
      run.status === 'completed' &&
      results.length === run.results.length &&
      results.every((r) => r.status === 'passed'),
  };
}
