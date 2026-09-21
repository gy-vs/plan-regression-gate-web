import express, {type Response} from 'express';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {RunEvent} from '../shared/types';
import {CATALOG} from './schema';
import {NotFoundError, RevisionConflict, Store} from './store';
import {defaultMeasure} from './measurement';
import {RunManager} from './runner';

class EventBus {
  private buffers = new Map<string, RunEvent[]>();
  private subscribers = new Map<string, Set<Response>>();

  emit(event: RunEvent) {
    const runId = event.type === 'done' ? event.run.id : event.runId;
    const buffer = this.buffers.get(runId) ?? [];
    buffer.push(event);
    this.buffers.set(runId, buffer);
    const listeners = this.subscribers.get(runId);
    if (listeners) {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of listeners) res.write(payload);
      if (event.type === 'done') {
        for (const res of listeners) res.end();
        this.subscribers.delete(runId);
      }
    }
  }

  /** Replay buffered events, then stream future ones. */
  subscribe(runId: string, res: Response, onFinished: () => void) {
    const buffer = this.buffers.get(runId) ?? [];
    for (const event of buffer) res.write(`data: ${JSON.stringify(event)}\n\n`);
    const done = buffer.some((event) => event.type === 'done');
    if (!done) {
      const set = this.subscribers.get(runId) ?? new Set<Response>();
      set.add(res);
      this.subscribers.set(runId, set);
      res.on('close', () => {
        set.delete(res);
      });
    } else {
      onFinished();
    }
  }
}

export function createApp(store = new Store(), runManager = new RunManager(2)) {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  const bus = new EventBus();

  app.get('/api/catalog', (_req, res) => {
    res.json(CATALOG);
  });

  app.get('/api/state', (_req, res) => {
    res.json({
      schemaRevision: CATALOG.schemaRevision,
      stats: store.stats,
      parameterSets: store.parameterSets,
      ruleSets: store.ruleSets,
      activeRuns: runManager.activeCount(),
      runCapacity: 2,
    });
  });

  app.post('/api/parameter-sets', (req, res) => {
    const set = req.body.parameterSet;
    if (!set || !set.id || !Array.isArray(set.samples)) {
      return res.status(400).json({error: 'invalid_parameter_set'});
    }
    if (store.findParameterSet(set.id)) {
      return res.status(409).json({error: 'already_exists'});
    }
    const created = {
      id: String(set.id),
      name: String(set.name ?? set.id),
      revision: 1,
      updatedAt: new Date().toISOString(),
      samples: set.samples,
    };
    store.parameterSets.push(created);
    return res.status(201).json(created);
  });

  app.put('/api/parameter-sets/:id/samples', (req, res) => {
    try {
      const sample = req.body.sample;
      const revision = Number(req.body.revision);
      if (!sample || !sample.id || !sample.label) {
        return res.status(400).json({error: 'invalid_sample'});
      }
      const updated = store.saveSample(req.params.id, sample, revision);
      return res.json(updated);
    } catch (err) {
      return handleError(err, res);
    }
  });

  app.delete('/api/parameter-sets/:id/samples/:sampleId', (req, res) => {
    try {
      const updated = store.deleteSample(
        req.params.id,
        req.params.sampleId,
        Number(req.query.revision),
      );
      return res.json(updated);
    } catch (err) {
      return handleError(err, res);
    }
  });

  app.put('/api/rules/:id', (req, res) => {
    try {
      const rules = req.body.rules;
      const revision = Number(req.body.revision);
      if (!rules || rules.id !== req.params.id) {
        return res.status(400).json({error: 'invalid_rules'});
      }
      const updated = store.saveRules(rules, revision);
      return res.json(updated);
    } catch (err) {
      return handleError(err, res);
    }
  });

  app.post('/api/stats/refresh', (req, res) => {
    // Body may carry updated row counts/selectivity; omitted fields carry over.
    const next = {
      rowCounts: {...store.stats.rowCounts, ...(req.body.rowCounts ?? {})},
      selectivity: req.body.selectivity
        ? req.body.selectivity
        : structuredClone(store.stats.selectivity),
    };
    return res.json(store.refreshStats(next));
  });

  app.post('/api/runs', (req, res) => {
    const parameterSet = store.findParameterSet(req.body.parameterSetId ?? 'ps-main');
    const rules = store.findRules(req.body.ruleSetId ?? 'rs-default');
    if (!parameterSet || !rules) return res.status(404).json({error: 'not_found'});
    if (parameterSet.samples.length === 0) {
      return res.status(400).json({error: 'empty_parameter_set'});
    }

    const id = `run-${randomUUID()}`;
    const concurrency = clampConcurrency(req.body.concurrency);
    const enableMeasurement = req.body.enableMeasurement !== false;
    const started = runManager.start(
      id,
      {
        parameterSetId: parameterSet.id,
        parameterSetRevision: parameterSet.revision,
        ruleRevision: rules.revision,
        statsRevision: store.stats.revision,
        samples: structuredClone(parameterSet.samples),
        rules: structuredClone(rules),
        // Stats are snapshot by value so a refresh mid-run cannot leak in.
        stats: structuredClone(store.stats),
      },
      {
        measure: defaultMeasure,
        enableMeasurement,
        concurrency,
        onEvent: (event) => bus.emit(event),
      },
    );

    if ('error' in started) {
      return res.status(409).json({
        error: 'run_capacity_exceeded',
        activeRuns: runManager.activeCount(),
      });
    }
    return res.status(202).json({runId: id, run: started});
  });

  app.get('/api/runs', (_req, res) => {
    res.json({runs: runManager.list(), activeRuns: runManager.activeCount()});
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = runManager.get(req.params.id);
    if (!run) return res.status(404).json({error: 'not_found'});
    res.json(run);
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const cancelled = runManager.cancel(req.params.id);
    if (!cancelled) return res.status(409).json({error: 'not_cancellable'});
    res.json({cancelling: true});
  });

  /**
   * Publish gate. A run can only be published against the exact rule (and
   * parameter set) revision it executed with: once rules move to a new
   * revision, older runs are stale and must be re-run.
   */
  app.post('/api/runs/:id/publish', (req, res) => {
    const run = runManager.get(req.params.id);
    if (!run) return res.status(404).json({error: 'not_found'});
    if (run.status !== 'completed') {
      return res.status(409).json({error: 'run_not_completed', status: run.status});
    }
    if (!run.summary?.passed) {
      return res.status(409).json({error: 'gate_failed', summary: run.summary});
    }
    const rules = store.findRules('rs-default');
    const parameterSet = store.findParameterSet(run.parameterSetId);
    if (rules && run.ruleRevision !== rules.revision) {
      return res.status(409).json({
        error: 'stale_rule_revision',
        runRuleRevision: run.ruleRevision,
        currentRuleRevision: rules.revision,
      });
    }
    if (parameterSet && run.parameterSetRevision !== parameterSet.revision) {
      return res.status(409).json({
        error: 'stale_parameter_set_revision',
        runRevision: run.parameterSetRevision,
        currentRevision: parameterSet.revision,
      });
    }
    runManager.markPublished(req.params.id);
    res.json({published: true, run: runManager.get(req.params.id)});
  });

  app.get('/api/runs/:id/events', (req, res) => {
    if (!runManager.get(req.params.id)) {
      return res.status(404).json({error: 'not_found'});
    }
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');
    bus.subscribe(req.params.id, res, () => {
      // Already finished: buffered `done` event was the last replay item.
      res.end();
    });
  });

  return app;
}

function clampConcurrency(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 4;
  return Math.min(Math.max(1, Math.floor(n)), 8);
}

function handleError(err: unknown, res: Response) {
  if (err instanceof RevisionConflict) {
    return res.status(409).json({error: 'revision_conflict', currentRevision: err.currentRevision});
  }
  if (err instanceof NotFoundError) {
    return res.status(404).json({error: 'not_found'});
  }
  throw err;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
