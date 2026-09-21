import express, { type NextFunction, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { GateRunner, HttpError, type RunnerOptions } from './runner';
import {
  createStores,
  isValidTableStatsMap,
  isValidThresholds,
  type Stores,
} from './store';
import type { QuerySpec, Sample } from './types';

export interface ServiceOptions extends RunnerOptions {}

export function createService(options: ServiceOptions = {}) {
  const stores = createStores();
  const runner = new GateRunner(stores, options);
  const app = buildApp(stores, runner);
  return { app, runner, stores };
}

export function createApp(options: ServiceOptions = {}) {
  return createService(options).app;
}

type Handler = (req: Request, res: Response) => void | Promise<void>;

const asyncHandler =
  (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

function badRequest(message: string): never {
  throw new HttpError(400, { error: 'bad_request', message });
}

function parseQuerySpec(value: unknown): QuerySpec {
  const q = value as QuerySpec;
  if (
    typeof q !== 'object' ||
    q === null ||
    typeof q.base !== 'string' ||
    !Array.isArray(q.joins) ||
    !Array.isArray(q.filters) ||
    !Array.isArray(q.labels)
  ) {
    badRequest('query must have base, joins, filters and labels');
  }
  return q;
}

function parseSamples(value: unknown): Sample[] {
  if (!Array.isArray(value)) badRequest('samples must be an array');
  for (const s of value as Sample[]) {
    if (typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.params !== 'object') {
      badRequest('each sample needs id, name and params');
    }
  }
  return value as Sample[];
}

function buildApp(stores: Stores, runner: GateRunner) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/bootstrap', (_req, res) => {
    res.json({
      family: 'query-plan-gate',
      paramSets: stores.paramSets.list().length,
      statsRevision: stores.stats.current().revision,
      rulesRevision: stores.rules.current().revision,
    });
  });

  // Parameter sets -----------------------------------------------------------
  app.get('/api/param-sets', (_req, res) => {
    res.json(stores.paramSets.list());
  });

  app.get('/api/param-sets/:id', (req, res) => {
    const set = stores.paramSets.get(req.params.id);
    if (!set) throw new HttpError(404, { error: 'not_found' });
    res.json(set);
  });

  app.post('/api/param-sets', (req, res) => {
    const body = req.body ?? {};
    if (typeof body.name !== 'string') badRequest('name is required');
    const set = stores.paramSets.create({
      id: typeof body.id === 'string' ? body.id : undefined,
      name: body.name,
      query: parseQuerySpec(body.query),
      samples: parseSamples(body.samples),
    });
    res.status(201).json(set);
  });

  app.put('/api/param-sets/:id', (req, res) => {
    const body = req.body ?? {};
    if (typeof body.revision !== 'number') badRequest('revision is required');
    const outcome = stores.paramSets.update(req.params.id, body.revision, {
      name: body.name,
      query: body.query === undefined ? undefined : parseQuerySpec(body.query),
      samples: body.samples === undefined ? undefined : parseSamples(body.samples),
    });
    if (outcome.status === 'missing') throw new HttpError(404, { error: 'not_found' });
    if (outcome.status === 'conflict') {
      throw new HttpError(409, { error: 'revision_conflict', current: outcome.current });
    }
    res.json(outcome.set);
  });

  // Statistics ---------------------------------------------------------------
  app.get('/api/stats', (_req, res) => {
    res.json(stores.stats.current());
  });

  app.get('/api/stats/:revision', (req, res) => {
    const snapshot = stores.stats.at(Number(req.params.revision));
    if (!snapshot) throw new HttpError(404, { error: 'not_found' });
    res.json(snapshot);
  });

  app.put('/api/stats', (req, res) => {
    const body = req.body ?? {};
    if (typeof body.revision !== 'number') badRequest('revision is required');
    if (!isValidTableStatsMap(body.tables)) badRequest('tables must be a valid stats map');
    const outcome = stores.stats.commit(body.revision, (next) => ({ ...next, tables: body.tables }));
    if (outcome.status === 'conflict') {
      throw new HttpError(409, { error: 'revision_conflict', current: outcome.current });
    }
    res.json(outcome.snapshot);
  });

  // Threshold rules ----------------------------------------------------------
  app.get('/api/rules', (_req, res) => {
    res.json(stores.rules.current());
  });

  app.put('/api/rules', (req, res) => {
    const body = req.body ?? {};
    if (typeof body.revision !== 'number') badRequest('revision is required');
    if (!isValidThresholds(body.defaults)) badRequest('defaults must be valid thresholds');
    if (typeof body.overrides !== 'object' || body.overrides === null) {
      badRequest('overrides must be an object keyed by label');
    }
    const outcome = stores.rules.commit(body.revision, (next) => ({
      ...next,
      defaults: body.defaults,
      overrides: body.overrides,
    }));
    if (outcome.status === 'conflict') {
      throw new HttpError(409, { error: 'revision_conflict', current: outcome.current });
    }
    res.json(outcome.snapshot);
  });

  // Gate runs ----------------------------------------------------------------
  app.post(
    '/api/gates',
    asyncHandler(async (req, res) => {
      const paramSetId = req.body?.paramSetId;
      if (typeof paramSetId !== 'string') badRequest('paramSetId is required');
      const run = runner.start(paramSetId);
      res.status(201).json(run);
    }),
  );

  app.get('/api/gates', (_req, res) => {
    res.json(runner.list());
  });

  app.get('/api/gates/:id', (req, res) => {
    const run = runner.get(req.params.id);
    if (!run) throw new HttpError(404, { error: 'not_found' });
    res.json(run);
  });

  // Server-sent events: snapshot first, then per-sample updates as they
  // finish, then a terminal done event carrying the full run.
  app.get('/api/gates/:id/events', (req, res) => {
    const run = runner.get(req.params.id);
    if (!run) throw new HttpError(404, { error: 'not_found' });
    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(`event: snapshot\ndata: ${JSON.stringify(run)}\n\n`);
    if (run.status !== 'running') {
      // Nothing more will happen; close instead of holding the connection.
      res.write(`event: done\ndata: ${JSON.stringify({ type: 'done', run })}\n\n`);
      res.end();
      return;
    }
    const unsubscribe = runner.subscribe(run.id, (event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done') res.end();
    });
    req.on('close', unsubscribe);
  });

  app.post('/api/gates/:id/cancel', (req, res) => {
    res.json(runner.cancel(req.params.id));
  });

  app.post('/api/gates/:id/publish', (req, res) => {
    res.json(runner.publish(req.params.id));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(err.body);
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
