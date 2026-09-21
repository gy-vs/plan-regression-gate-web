import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp, createService } from '../src/server/index';
import type { RunEvent } from '../src/server/runner';
import type { GateRun, Measurer, ParamSet, StatsSnapshot } from '../src/server/types';

type App = ReturnType<typeof createApp>;

async function waitForRun(app: App, id: string): Promise<GateRun> {
  for (let i = 0; i < 500; i += 1) {
    const res = await request(app).get(`/api/gates/${id}`);
    if (res.body.status !== 'running') return res.body as GateRun;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${id} did not finish`);
}

async function createSet(
  app: App,
  over: Record<string, unknown> = {},
): Promise<ParamSet> {
  const res = await request(app)
    .post('/api/param-sets')
    .send({
      name: 'test set',
      query: {
        base: 'orders',
        joins: [],
        filters: [{ table: 'orders', column: 'amount', op: 'gt', param: 'minAmount' }],
        labels: [],
      },
      samples: [{ id: 's1', name: 'sample 1', params: { minAmount: 975 } }],
      ...over,
    })
    .expect(201);
  return res.body as ParamSet;
}

async function runGate(app: App, paramSetId: string): Promise<GateRun> {
  const res = await request(app).post('/api/gates').send({ paramSetId }).expect(201);
  return waitForRun(app, res.body.id);
}

const slowMeasurer =
  (ms: number): Measurer =>
  async ({ signal }) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject({ code: 'aborted' });
      });
    });
    return { runtimeMs: 10 };
  };

describe('parameter sets keep optimistic revisioning', () => {
  it('rejects updates with a stale revision', async () => {
    const app = createApp();
    const before = await request(app).get('/api/param-sets/alpha').expect(200);
    await request(app)
      .put('/api/param-sets/alpha')
      .send({ revision: before.body.revision, name: 'renamed' })
      .expect(200);
    const conflict = await request(app)
      .put('/api/param-sets/alpha')
      .send({ revision: before.body.revision, name: 'stale' })
      .expect(409);
    expect(conflict.body.error).toBe('revision_conflict');
  });
});

describe('parameters drive different plans', () => {
  it('reports structural diffs per sample with evidence', async () => {
    const app = createApp();
    const run = await runGate(app, 'alpha');
    expect(run.status).toBe('completed');
    expect(run.decision).toBe('failed'); // sample a4 breaches the estimation threshold

    const [a1, a2, a3, a4] = run.samples;
    // minAmount=5: legacy picks IndexScan, new optimizer picks SeqScan.
    expect(a1.structuralDiffCount).toBe(1);
    expect(a1.status).toBe('passed'); // tolerated by the oltp label override
    expect(a1.appliedOverrides).toEqual(['oltp']);
    // minAmount=975: both optimizers pick the index.
    expect(a3.structuralDiffCount).toBe(0);
    expect(a2.status).toBe('passed');

    expect(a4.status).toBe('failed');
    const estimation = a4.checks?.find((c) => c.name === 'estimation');
    expect(estimation?.status).toBe('fail');
    expect(estimation?.evidence).toMatchObject({ threshold: 0.25 });
    expect(Number(estimation?.evidence?.error)).toBeGreaterThan(0.4);
  });
});

describe('missing estimates', () => {
  it('fails the estimation check with concrete evidence', async () => {
    const app = createApp();
    const set = await createSet(app, {
      query: {
        base: 'orders',
        joins: [],
        filters: [{ table: 'orders', column: 'coupon', op: 'eq', param: 'coupon' }],
        labels: [],
      },
      samples: [{ id: 's1', name: 'no stats', params: { coupon: 'X' } }],
    });
    const run = await runGate(app, set.id);
    const [sample] = run.samples;
    expect(sample.status).toBe('failed');
    const estimation = sample.checks?.find((c) => c.name === 'estimation');
    expect(estimation?.evidence).toMatchObject({ reason: 'missing_estimate' });
    expect(run.summary?.validPairs).toBe(1);
  });

  it('marks samples invalid when planning is impossible', async () => {
    const app = createApp();
    const set = await createSet(app, {
      query: {
        base: 'ghost',
        joins: [],
        filters: [],
        labels: [],
      },
    });
    const run = await runGate(app, set.id);
    expect(run.samples[0].status).toBe('invalid');
    expect(run.samples[0].reason).toMatchObject({ type: 'plan_error' });
    expect(run.summary?.validPairs).toBe(0);
    expect(run.decision).toBe('failed');
  });
});

describe('measurement timeout', () => {
  it('marks the sample invalid and excludes it from the summary', async () => {
    const hangOnNew: Measurer = async ({ plan }) => {
      if (plan.optimizer === 'new') return new Promise(() => {});
      return { runtimeMs: 10 };
    };
    const app = createApp({ measurer: hangOnNew, measureTimeoutMs: 40 });
    const set = await createSet(app);
    const run = await runGate(app, set.id);
    expect(run.samples[0].status).toBe('invalid');
    expect(run.samples[0].reason).toMatchObject({ type: 'measurement_timeout', timeoutMs: 40 });
    expect(run.summary).toMatchObject({ total: 1, validPairs: 0, invalid: 1 });
    expect(run.summary?.maxEstError).toBeNull();
    expect(run.decision).toBe('failed');
  });
});

describe('partial failure', () => {
  it('summarizes valid pairs only while reporting every outcome', async () => {
    const hangOnP3: Measurer = async ({ sample }) => {
      if (sample.id === 'p3') return new Promise(() => {});
      return { runtimeMs: 10 };
    };
    const app = createApp({ measurer: hangOnP3, measureTimeoutMs: 40 });
    const set = await createSet(app, {
      samples: [
        { id: 'p1', name: 'passes', params: { minAmount: 975 } },
        { id: 'p2', name: 'estimation fails', params: { minAmount: 1001 } },
        { id: 'p3', name: 'measurement hangs', params: { minAmount: 5 } },
      ],
    });
    const run = await runGate(app, set.id);
    expect(run.samples.map((s) => s.status)).toEqual(['passed', 'failed', 'invalid']);
    expect(run.summary).toMatchObject({
      total: 3,
      validPairs: 2,
      passed: 1,
      failed: 1,
      invalid: 1,
      skipped: 0,
    });
    // maxEstError comes from the valid pairs only.
    expect(run.summary?.maxEstError).toBeGreaterThan(0.4);
    expect(run.decision).toBe('failed');
  });
});

describe('label overrides decide the verdict', () => {
  it('applies stricter thresholds to labelled queries', async () => {
    const app = createApp();
    const rules = (await request(app).get('/api/rules')).body;
    await request(app)
      .put('/api/rules')
      .send({
        revision: rules.revision,
        defaults: rules.defaults,
        overrides: { ...rules.overrides, strict: { maxEstError: 0.01 } },
      })
      .expect(200);

    // minAmount=975 has ~2.4% estimation error: fine by default, too high for "strict".
    const plain = await createSet(app, { name: 'plain' });
    const strict = await createSet(app, {
      name: 'strict',
      query: {
        base: 'orders',
        joins: [],
        filters: [{ table: 'orders', column: 'amount', op: 'gt', param: 'minAmount' }],
        labels: ['strict'],
      },
    });
    const plainRun = await runGate(app, plain.id);
    const strictRun = await runGate(app, strict.id);
    expect(plainRun.samples[0].status).toBe('passed');
    expect(strictRun.samples[0].status).toBe('failed');
    const estimation = strictRun.samples[0].checks?.find((c) => c.name === 'estimation');
    expect(estimation?.evidence).toMatchObject({ threshold: 0.01 });
  });
});

describe('statistics revisions', () => {
  it('pins the stats snapshot at run start and keeps old revisions readable', async () => {
    const app = createApp({ measurer: slowMeasurer(30), concurrency: 1 });
    const set = await createSet(app, {
      samples: [{ id: 's1', name: 'boundary', params: { minAmount: 1001 } }],
    });

    const started = await request(app).post('/api/gates').send({ paramSetId: set.id }).expect(201);

    // Update statistics while the run is in flight.
    const stats = (await request(app).get('/api/stats')).body as StatsSnapshot;
    const doubled = structuredClone(stats.tables);
    doubled.orders.rowCount = 200000;
    const updated = await request(app)
      .put('/api/stats')
      .send({ revision: stats.revision, tables: doubled })
      .expect(200);
    expect(updated.body.revision).toBe(stats.revision + 1);

    // The in-flight run still reflects the old snapshot.
    const run1 = await waitForRun(app, started.body.id);
    expect(run1.statsRevision).toBe(stats.revision);
    const evidence1 = run1.samples[0].checks?.find((c) => c.name === 'estimation')?.evidence;
    expect(Number(evidence1?.estRows)).toBeCloseTo(100000 / 7, 0);

    // A new run uses the new revision, and the old snapshot stays readable.
    const run2 = await runGate(app, set.id);
    expect(run2.statsRevision).toBe(stats.revision + 1);
    const evidence2 = run2.samples[0].checks?.find((c) => c.name === 'estimation')?.evidence;
    expect(Number(evidence2?.estRows)).toBeCloseTo(200000 / 7, 0);
    const old = await request(app).get(`/api/stats/${stats.revision}`).expect(200);
    expect(old.body.tables.orders.rowCount).toBe(100000);
  });
});

describe('concurrent gates', () => {
  it('runs two gates simultaneously with independent state', async () => {
    const { app, runner } = createService({ measurer: slowMeasurer(20), concurrency: 1 });
    const a = await request(app).post('/api/gates').send({ paramSetId: 'alpha' }).expect(201);
    const b = await request(app).post('/api/gates').send({ paramSetId: 'beta' }).expect(201);

    const midA = await request(app).get(`/api/gates/${a.body.id}`);
    const midB = await request(app).get(`/api/gates/${b.body.id}`);
    expect(midA.body.status).toBe('running');
    expect(midB.body.status).toBe('running');

    const [doneA, doneB] = await Promise.all([
      waitForRun(app, a.body.id),
      waitForRun(app, b.body.id),
    ]);
    expect(doneA.paramSetId).toBe('alpha');
    expect(doneA.samples).toHaveLength(4);
    expect(doneB.paramSetId).toBe('beta');
    expect(doneB.samples).toHaveLength(2);
    // beta reorders joins under the new optimizer and has no structural override.
    expect(doneB.samples[0].structuralDiffCount).toBeGreaterThan(0);
    expect(runner.list()).toHaveLength(2);
  });

  it('streams sample events then a terminal done event', async () => {
    const { runner } = createService({ concurrency: 2 });
    const events: RunEvent[] = [];
    const run = runner.start('alpha');
    const unsubscribe = runner.subscribe(run.id, (event) => events.push(event));
    for (let i = 0; i < 500 && runner.get(run.id)?.status === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    unsubscribe();
    const done = events.filter((e) => e.type === 'done');
    expect(done).toHaveLength(1);
    const terminal = new Set(
      events
        .filter((e) => e.type === 'sample' && ['passed', 'failed', 'invalid', 'skipped'].includes(e.result.status))
        .map((e) => (e.type === 'sample' ? e.result.sampleId : '')),
    );
    expect(terminal).toEqual(new Set(['a1', 'a2', 'a3', 'a4']));
  });
});

describe('cancellation', () => {
  it('distinguishes not-run samples from failed ones', async () => {
    const app = createApp({ measurer: slowMeasurer(25), concurrency: 1 });
    const set = await createSet(app, {
      samples: [
        { id: 's1', name: 'fails first', params: { minAmount: 1001 } },
        { id: 's2', name: 'never reached', params: { minAmount: 1001 } },
        { id: 's3', name: 'also never reached', params: { minAmount: 1001 } },
      ],
    });
    const started = await request(app).post('/api/gates').send({ paramSetId: set.id }).expect(201);

    // Wait for the first sample to fail, then cancel.
    let first: GateRun['samples'][0] | undefined;
    for (let i = 0; i < 500; i += 1) {
      const res = await request(app).get(`/api/gates/${started.body.id}`);
      first = res.body.samples[0];
      if (first?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(first?.status).toBe('failed');

    await request(app).post(`/api/gates/${started.body.id}/cancel`).expect(200);
    const run = await waitForRun(app, started.body.id);
    expect(run.status).toBe('cancelled');
    expect(run.decision).toBeUndefined();
    expect(run.samples[0].status).toBe('failed'); // the failure is preserved
    const rest = run.samples.slice(1);
    expect(rest.length).toBeGreaterThan(0);
    for (const sample of rest) {
      expect(sample.status).toBe('skipped'); // not run, not failed
      expect(sample.reason).toMatchObject({ type: 'cancelled' });
    }
    expect(run.summary?.skipped).toBe(rest.length);
    expect(run.summary?.failed).toBe(1);
  });
});

describe('publishing', () => {
  it('blocks publishing an old run onto a newer rules revision', async () => {
    const app = createApp();
    const set = await createSet(app);
    const run = await runGate(app, set.id);
    expect(run.decision).toBe('passed');

    const published = await request(app).post(`/api/gates/${run.id}/publish`).expect(200);
    expect(published.body.revisions).toEqual({
      paramSet: run.paramSetRevision,
      stats: run.statsRevision,
      rules: run.rulesRevision,
    });

    // Rules move on; the old run can no longer be published.
    const rules = (await request(app).get('/api/rules')).body;
    await request(app)
      .put('/api/rules')
      .send({ revision: rules.revision, defaults: rules.defaults, overrides: rules.overrides })
      .expect(200);
    const stale = await request(app).post(`/api/gates/${run.id}/publish`).expect(409);
    expect(stale.body).toMatchObject({
      error: 'stale_rules_revision',
      runRulesRevision: run.rulesRevision,
      currentRulesRevision: rules.revision + 1,
    });

    // A fresh run against the new rules publishes fine.
    const rerun = await runGate(app, set.id);
    expect(rerun.rulesRevision).toBe(rules.revision + 1);
    await request(app).post(`/api/gates/${rerun.id}/publish`).expect(200);
  });

  it('rejects publishing a cancelled run', async () => {
    const app = createApp({ measurer: slowMeasurer(25), concurrency: 1 });
    const set = await createSet(app, {
      samples: [
        { id: 's1', name: 'one', params: { minAmount: 1 } },
        { id: 's2', name: 'two', params: { minAmount: 2 } },
      ],
    });
    const started = await request(app).post('/api/gates').send({ paramSetId: set.id }).expect(201);
    await request(app).post(`/api/gates/${started.body.id}/cancel`).expect(200);
    const run = await waitForRun(app, started.body.id);
    expect(run.status).toBe('cancelled');
    const res = await request(app).post(`/api/gates/${run.id}/publish`).expect(409);
    expect(res.body.error).toBe('run_not_completed');
  });
});
