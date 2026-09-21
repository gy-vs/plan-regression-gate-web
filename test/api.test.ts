import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {RunEvent, Sample, SampleResult} from '../src/shared/types';

function passingSamples(): Sample[] {
  // customer_lookup: identical shapes, exact estimates -> clean pass.
  return [
    {id: 'a', label: 'customer_lookup', name: 'a', params: {}},
    {id: 'b', label: 'customer_lookup', name: 'b', params: {}},
  ];
}

async function createPassingSet(app: ReturnType<typeof createApp>, id = 'ps-pass') {
  await request(app)
    .post('/api/parameter-sets')
    .send({parameterSet: {id, name: 'passing', samples: passingSamples()}})
    .expect(201);
  return id;
}

function startRun(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
) {
  return request(app).post('/api/runs').send(body).expect(202);
}

async function waitRun(app: ReturnType<typeof createApp>, runId: string) {
  for (let i = 0; i < 200; i += 1) {
    const res = await request(app).get(`/api/runs/${runId}`);
    if (res.body.status !== 'running') return res.body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('run never finished');
}

/** Collect SSE events using supertest's streaming response. */
function collectEvents(
  app: ReturnType<typeof createApp>,
  runId: string,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let buffer = '';
  const finished = new Promise<RunEvent[]>((resolve) => {
    request(app)
      .get(`/api/runs/${runId}/events`)
      .buffer(false)
      .parse((res, cb) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const event = JSON.parse(line.slice(6)) as RunEvent;
              events.push(event);
            }
          }
        });
        res.on('end', () => {
          if (buffer.startsWith('data: ')) {
            events.push(JSON.parse(buffer.slice(6)));
          }
          cb(null, events);
        });
        res.on('error', (err) => cb(err, undefined as never));
      })
      .then(() => resolve(events));
  });
  return finished;
}

describe('catalog and state', () => {
  it('pins the schema and reports revisions', async () => {
    const app = createApp();
    const catalog = await request(app).get('/api/catalog').expect(200);
    expect(catalog.body.schemaRevision).toBe(1);
    expect(catalog.body.tables.length).toBeGreaterThan(0);

    const state = await request(app).get('/api/state').expect(200);
    expect(state.body.stats.revision).toBe(1);
    expect(state.body.parameterSets[0].revision).toBe(1);
    expect(state.body.ruleSets[0].revision).toBe(1);
  });
});

describe('parameter samples optimistic concurrency', () => {
  it('saves a sample with the pinned revision and conflicts on stale writes', async () => {
    const app = createApp();
    const before = await request(app).get('/api/state');
    const rev = before.body.parameterSets[0].revision;
    const sample: Sample = {
      id: 's-new',
      label: 'customer_lookup',
      name: 'new sample',
      params: {k: 'v'},
    };
    const saved = await request(app)
      .put('/api/parameter-sets/ps-main/samples')
      .send({revision: rev, sample})
      .expect(200);
    expect(saved.body.revision).toBe(rev + 1);

    const stale = await request(app)
      .put('/api/parameter-sets/ps-main/samples')
      .send({revision: rev, sample})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.currentRevision).toBe(rev + 1);
  });
});

describe('gate run streaming', () => {
  it('emits ordered SSE events and a final summary with evidence', async () => {
    const app = createApp();
    const started = await startRun(app, {parameterSetId: 'ps-main', concurrency: 2});
    const runId = started.body.runId as string;
    const events = await collectEvents(app, runId);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run_started');
    expect(types[types.length - 1]).toBe('done');
    expect(types.filter((t) => t === 'sample').length).toBeGreaterThan(0);

    const done = events.find((e) => e.type === 'done')!;
    if (done.type !== 'done') throw new Error('impossible');
    const results = done.run.results as SampleResult[];
    expect(done.run.status).toBe('completed');
    // Samples keep their original order.
    const indices = results.map((r) => r.index);
    expect(indices).toEqual(results.map((_r, i) => i));
    // Default set contains a structure change, missing estimate and timeout.
    const failed = results.filter((r) => r.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    const withEvidence = failed.find((r) =>
      r.labels.some(
        (l) => l.checks.some((c) => c.evidence) || l.error?.message,
      ),
    );
    expect(withEvidence).toBeTruthy();
    expect(done.run.summary!.passed).toBe(false);
  });

  it('replays buffered events to a late subscriber', async () => {
    const app = createApp();
    const setId = await createPassingSet(app);
    const started = await startRun(app, {parameterSetId: setId, concurrency: 2});
    const runId = started.body.runId as string;
    await waitRun(app, runId);
    const events = await collectEvents(app, runId);
    expect(events.at(-1)?.type).toBe('done');
    expect(events.length).toBeGreaterThanOrEqual(4);
  });
});

describe('cancellation', () => {
  it('marks never-run samples separately from failures', async () => {
    const app = createApp();
    const samples: Sample[] = Array.from({length: 10}, (_, i) => ({
      id: `t${i}`,
      label: 'slow_report',
      name: `t${i}`,
      params: {delayMs: 400},
    }));
    await request(app)
      .post('/api/parameter-sets')
      .send({parameterSet: {id: 'ps-slow', samples}})
      .expect(201);

    const started = await startRun(app, {parameterSetId: 'ps-slow', concurrency: 2});
    const runId = started.body.runId;
    await request(app).post(`/api/runs/${runId}/cancel`).expect(200);
    const run = await waitRun(app, runId);

    expect(run.status).toBe('cancelled');
    const notRun = run.results.filter((r: {notRun?: boolean}) => r.notRun).length;
    expect(notRun).toBeGreaterThan(0);
    // Timeouts (failures) and not-run samples are both represented distinctly.
    expect(run.results.every((r: unknown) => r !== null)).toBe(true);
    const secondCancel = await request(app).post(`/api/runs/${runId}/cancel`);
    expect([409]).toContain(secondCancel.status);
  });
});

describe('threshold override and boundary', () => {
  it('applies a per-label threshold override on a boundary sample', async () => {
    const app = createApp();
    // actual 8000 vs est 10000 -> ratio exactly 0.25, default inclusive pass.
    const boundary: Sample = {
      id: 'b',
      label: 'boundary_estimate',
      name: 'b',
      params: {actualRows: 8000},
    };
    await request(app)
      .post('/api/parameter-sets')
      .send({parameterSet: {id: 'ps-b', samples: [boundary]}})
      .expect(201);

    const ok = await startRun(app, {parameterSetId: 'ps-b'});
    const okRun = await waitRun(app, ok.body.runId);
    expect(okRun.summary.passed).toBe(true);

    // Tighten the threshold with a label override: ratio 0.25 now fails.
    const state = await request(app).get('/api/state');
    const current = state.body.ruleSets[0];
    const tightened = {
      ...current,
      labels: [...current.labels, {label: 'boundary_estimate', maxEstErrorRatio: 0.2499}],
    };
    await request(app)
      .put('/api/rules/rs-default')
      .send({revision: current.revision, rules: tightened})
      .expect(200);

    const fail = await startRun(app, {parameterSetId: 'ps-b'});
    const failRun = await waitRun(app, fail.body.runId);
    expect(failRun.summary.passed).toBe(false);
    const check = failRun.results[0].labels[0].checks.find(
      (c: {name: string}) => c.name === 'estimated_rows',
    );
    expect(check.evidence).toContain('exceeds threshold');
  });
});

describe('stats revision', () => {
  it('bumps the revision on refresh and pins it on runs', async () => {
    const app = createApp();
    const refreshed = await request(app)
      .post('/api/stats/refresh')
      .send({rowCounts: {orders: 2_000_000}})
      .expect(200);
    expect(refreshed.body.revision).toBe(2);
    expect(refreshed.body.rowCounts.orders).toBe(2_000_000);
    // Unchanged tables carry over.
    expect(refreshed.body.rowCounts.customers).toBe(50_000);

    const setId = await createPassingSet(app);
    const started = await startRun(app, {parameterSetId: setId});
    // Refresh again mid-lifecycle; the running/completed run keeps rev 2.
    await request(app).post('/api/stats/refresh').send({}).expect(200);
    const run = await waitRun(app, started.body.runId);
    expect(run.statsRevision).toBe(2);
    const now = await request(app).get('/api/state');
    expect(now.body.stats.revision).toBe(3);
  });
});

describe('two concurrent gates', () => {
  it('runs two gates simultaneously and refuses a third', async () => {
    const app = createApp();
    await request(app)
      .post('/api/parameter-sets')
      .send({
        parameterSet: {
          id: 'ps-slow-a',
          samples: [{id: 'a', label: 'slow_report', name: 'a', params: {delayMs: 300}}],
        },
      })
      .expect(201);
    await request(app)
      .post('/api/parameter-sets')
      .send({
        parameterSet: {
          id: 'ps-slow-b',
          samples: [{id: 'b', label: 'slow_report', name: 'b', params: {delayMs: 300}}],
        },
      })
      .expect(201);

    const first = await startRun(app, {parameterSetId: 'ps-slow-a', concurrency: 1});
    const second = await startRun(app, {parameterSetId: 'ps-slow-b', concurrency: 1});
    expect(first.body.runId).not.toBe(second.body.runId);

    const third = await request(app)
      .post('/api/runs')
      .send({parameterSetId: 'ps-slow-a'})
      .expect(409);
    expect(third.body.error).toBe('run_capacity_exceeded');

    const [a, b] = await Promise.all([
      waitRun(app, first.body.runId),
      waitRun(app, second.body.runId),
    ]);
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
  });
});

describe('publish guard', () => {
  it('publishes a fresh passing run and rejects failed or stale runs', async () => {
    const app = createApp();

    // A failed default run cannot be published.
    const failed = await startRun(app, {parameterSetId: 'ps-main'});
    const failedRun = await waitRun(app, failed.body.runId);
    expect(failedRun.summary.passed).toBe(false);
    await request(app).post(`/api/runs/${failed.body.runId}/publish`).expect(409);

    // A passing run publishes while revisions match.
    const setId = await createPassingSet(app);
    const good = await startRun(app, {parameterSetId: setId});
    const goodRun = await waitRun(app, good.body.runId);
    expect(goodRun.summary.passed).toBe(true);
    await request(app).post(`/api/runs/${good.body.runId}/publish`).expect(200);

    // Advance the rule revision; the earlier passing run is now stale.
    const state = await request(app).get('/api/state');
    const current = state.body.ruleSets[0];
    const next = {...current, defaults: {...current.defaults, maxEstErrorRatio: 0.2}};
    await request(app)
      .put('/api/rules/rs-default')
      .send({revision: current.revision, rules: next})
      .expect(200);
    const stale = await request(app)
      .post(`/api/runs/${good.body.runId}/publish`)
      .expect(409);
    expect(stale.body.error).toBe('stale_rule_revision');
    expect(stale.body.runRuleRevision).toBe(goodRun.ruleRevision);
    expect(stale.body.currentRuleRevision).toBe(current.revision + 1);

    // A new run against the new rule revision can publish again.
    const fresh = await startRun(app, {parameterSetId: setId});
    const freshRun = await waitRun(app, fresh.body.runId);
    expect(freshRun.ruleRevision).toBe(current.revision + 1);
    await request(app).post(`/api/runs/${fresh.body.runId}/publish`).expect(200);
  });

  it('does not publish a cancelled run', async () => {
    const app = createApp();
    const samples: Sample[] = [
      {id: 'a', label: 'customer_lookup', name: 'a', params: {}},
      {id: 'b', label: 'slow_report', name: 'b', params: {delayMs: 500}},
    ];
    await request(app)
      .post('/api/parameter-sets')
      .send({parameterSet: {id: 'ps-cancel', samples}})
      .expect(201);
    const started = await startRun(app, {parameterSetId: 'ps-cancel', concurrency: 1});
    await request(app).post(`/api/runs/${started.body.runId}/cancel`).expect(200);
    await waitRun(app, started.body.runId);
    const res = await request(app).post(`/api/runs/${started.body.runId}/publish`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('run_not_completed');
  });
});
