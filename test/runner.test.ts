import {describe, expect, it, vi} from 'vitest';
import {RunManager, summarize} from '../src/server/runner';
import {defaultMeasure, type MeasureFn} from '../src/server/measurement';
import {initialStats} from '../src/server/schema';
import type {GateRun, ParameterSet, RuleSet, RunEvent, Sample} from '../src/shared/types';

function makeSamples(count: number, delayMs = 0): Sample[] {
  return Array.from({length: count}, (_, i) => ({
    id: `s${i}`,
    label: 'customer_lookup',
    name: `sample ${i}`,
    params: delayMs ? {delayMs} as Sample['params'] : {},
  }));
}

const rules: RuleSet = {
  id: 'rs',
  name: 'r',
  revision: 1,
  updatedAt: new Date(0).toISOString(),
  defaults: {structureChangeAllowed: false, maxEstErrorRatio: 10, measurementTimeoutMs: 500},
  labels: [],
};

function parameterSet(samples: Sample[], revision = 1): ParameterSet {
  return {id: 'ps', name: 'ps', revision, updatedAt: new Date(0).toISOString(), samples};
}

function startRun(
  manager: RunManager,
  samples: Sample[],
  onEvent: (event: RunEvent) => void = () => {},
  concurrency = 2,
  opts: {measure?: MeasureFn; enableMeasurement?: boolean} = {},
) {
  const id = `run-${Math.random()}`;
  const started = manager.start(
    id,
    {
      parameterSetId: 'ps',
      parameterSetRevision: 1,
      ruleRevision: 1,
      statsRevision: 1,
      samples,
      rules,
      stats: initialStats(),
    },
    {
      measure: opts.measure ?? defaultMeasure,
      enableMeasurement: opts.enableMeasurement ?? true,
      concurrency,
      onEvent,
    },
  );
  if ('error' in started) throw new Error('capacity');
  return started.id;
}

async function waitFor(manager: RunManager, id: string) {
  for (let i = 0; i < 100; i += 1) {
    const run = manager.get(id)!;
    if (run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('run did not finish');
}

describe('RunManager', () => {
  it('streams events but preserves original sample order in results', async () => {
    const manager = new RunManager(2);
    const events: number[] = [];
    const samples = makeSamples(6, 15);
    const id = startRun(manager, samples, (event) => {
      if (event.type === 'sample') events.push(event.result.index);
    }, 3);

    const run = await waitFor(manager, id);
    // Completion order may be arbitrary (events recorded raw order)...
    expect(events).toHaveLength(6);
    // ...but the results array stays in declared sample order.
    expect(run.results.map((r, i) => r?.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(run.results.map((r) => r?.sampleId)).toEqual(samples.map((s) => s.id));
  });

  it('cancellation distinguishes not-run samples from failed samples', async () => {
    const manager = new RunManager(2);
    // 8 slow samples, concurrency 1: cancel immediately -> only some ever run.
    const samples = makeSamples(8, 150);
    const id = startRun(manager, samples, () => {}, 1);
    manager.cancel(id);

    const run = await waitFor(manager, id);
    expect(run.status).toBe('cancelled');
    const notRun = run.results.filter((r) => r?.notRun);
    const failed = run.results.filter((r) => r && !r.notRun && r.status === 'failed');
    expect(notRun.length + failed.length).toBe(8);
    expect(notRun.length).toBeGreaterThan(0);
    // Every slot is filled and order is intact.
    expect(run.results.every((r) => r !== null)).toBe(true);
    expect(run.summary?.notRun).toBe(notRun.length);
    expect(run.summary?.passed).toBe(false);
  });

  it('limits to two concurrent gates and rejects a third', async () => {
    const manager = new RunManager(2);
    const samples = makeSamples(4, 100);
    const a = startRun(manager, samples);
    const b = startRun(manager, samples);
    expect(manager.hasCapacity()).toBe(false);

    const rejected = manager.start(
      'run-c',
      {
        parameterSetId: 'ps',
        parameterSetRevision: 1,
        ruleRevision: 1,
        statsRevision: 1,
        samples,
        rules,
        stats: initialStats(),
      },
      {measure: defaultMeasure, enableMeasurement: true, concurrency: 1, onEvent: () => {}},
    );
    expect(rejected).toEqual({error: 'capacity'});

    const [ra, rb] = await Promise.all([waitFor(manager, a), waitFor(manager, b)]);
    expect(ra.status).toBe('completed');
    expect(rb.status).toBe('completed');
    // Capacity frees up after both finish.
    expect(manager.hasCapacity()).toBe(true);
  });

  it('two independent gates run at the same time with isolated samples', async () => {
    const manager = new RunManager(2);
    const active = vi.fn(() => manager.activeCount());
    const idA = startRun(manager, makeSamples(3, 80), active, 1);
    const idB = startRun(manager, makeSamples(2, 60), active, 1);
    expect(manager.activeCount()).toBe(2);
    const [a, b] = await Promise.all([waitFor(manager, idA), waitFor(manager, idB)]);
    expect(a.results).toHaveLength(3);
    expect(b.results).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
  });

  it('summary aggregates valid paired results only', async () => {
    const manager = new RunManager(2);
    const mixed: Sample[] = [
      {id: 'ok', label: 'customer_lookup', name: 'ok', params: {}},
      {id: 'bad-est', label: 'adhoc_no_stats', name: 'bad', params: {}},
      {id: 'slow', label: 'slow_report', name: 'timeout', params: {delayMs: 5000}},
    ];
    const id = startRun(manager, mixed, () => {}, 2);
    const run = await waitFor(manager, id);

    expect(run.summary?.validPairs).toBe(1);
    expect(run.summary?.failedPairs).toBe(2);
    // The two invalid pairs are excluded from the aggregate.
    expect(run.summary?.maxEstErrorRatio).toBe(0);
    expect(run.summary?.excluded).toBe(2);
    expect(run.summary?.passed).toBe(false);
  });

  it('summarize() tolerates null slots', () => {
    const partial: GateRun = {
      id: 'r',
      parameterSetId: 'ps',
      parameterSetRevision: 1,
      ruleRevision: 1,
      statsRevision: 1,
      concurrency: 1,
      status: 'cancelled',
      createdAt: new Date(0).toISOString(),
      finishedAt: null,
      published: false,
      summary: null,
      results: [null, null],
    };
    const summary = summarize(partial);
    expect(summary.validPairs).toBe(0);
    expect(summary.maxEstErrorRatio).toBeNull();
    expect(summary.passed).toBe(false);
  });
});
