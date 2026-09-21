import type {
  ParameterSet,
  RuleSet,
  Sample,
  StatsSnapshot,
} from '../shared/types';
import {initialStats} from './schema';

/**
 * In-memory pinned state. Parameter sets, rule sets and stats each carry a
 * revision. A gate run snapshots all three revisions up front; later edits
 * (including stats refresh) never affect an in-flight run.
 */
export class Store {
  parameterSets: ParameterSet[];
  ruleSets: RuleSet[];
  stats: StatsSnapshot;

  constructor() {
    this.stats = initialStats();
    this.parameterSets = [defaultParameterSet()];
    this.ruleSets = [defaultRules()];
  }

  findParameterSet(id: string): ParameterSet | undefined {
    return this.parameterSets.find((set) => set.id === id);
  }

  findRules(id: string): RuleSet | undefined {
    return this.ruleSets.find((set) => set.id === id);
  }

  /** Add (or replace) a sample. Optimistic-concurrency revision check. */
  saveSample(setId: string, sample: Sample, expectedRevision: number): ParameterSet {
    const set = this.mustFindParameterSet(setId);
    if (set.revision !== expectedRevision) {
      const err = new RevisionConflict(set.revision);
      throw err;
    }
    const existing = set.samples.findIndex((s) => s.id === sample.id);
    if (existing >= 0) set.samples[existing] = sample;
    else set.samples.push(sample);
    set.revision += 1;
    set.updatedAt = new Date().toISOString();
    return set;
  }

  deleteSample(setId: string, sampleId: string, expectedRevision: number): ParameterSet {
    const set = this.mustFindParameterSet(setId);
    if (set.revision !== expectedRevision) throw new RevisionConflict(set.revision);
    set.samples = set.samples.filter((s) => s.id !== sampleId);
    set.revision += 1;
    set.updatedAt = new Date().toISOString();
    return set;
  }

  saveRules(rules: RuleSet, expectedRevision: number): RuleSet {
    const existing = this.mustFindRules(rules.id);
    if (existing.revision !== expectedRevision) throw new RevisionConflict(existing.revision);
    Object.assign(existing, rules, {
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    return existing;
  }

  /** Stats refresh bumps the stats revision; running gates keep their snapshot. */
  refreshStats(next: Omit<StatsSnapshot, 'revision' | 'updatedAt'>): StatsSnapshot {
    this.stats = {
      ...next,
      revision: this.stats.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    return this.stats;
  }

  private mustFindParameterSet(id: string): ParameterSet {
    const set = this.findParameterSet(id);
    if (!set) throw new NotFoundError('parameter_set');
    return set;
  }

  private mustFindRules(id: string): RuleSet {
    const set = this.findRules(id);
    if (!set) throw new NotFoundError('rules');
    return set;
  }
}

export class NotFoundError extends Error {
  constructor(kind: string) {
    super(`${kind} not found`);
    this.name = 'NotFoundError';
  }
}

export class RevisionConflict extends Error {
  constructor(readonly currentRevision: number) {
    super(`revision conflict; current revision is ${currentRevision}`);
    this.name = 'RevisionConflict';
  }
}

function defaultParameterSet(): ParameterSet {
  return {
    id: 'ps-main',
    name: 'Main parameter samples',
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    samples: [
      {
        id: 's-plan-change',
        label: 'orders_by_customer',
        name: 'Customer filter (old seq scan vs new index)',
        params: {},
      },
      {
        id: 's-slow-report',
        label: 'slow_report',
        name: 'Status report with sort',
        params: {},
      },
      {
        id: 's-lookup',
        label: 'customer_lookup',
        name: 'Point lookup',
        params: {},
      },
      {
        id: 's-missing-estimate',
        label: 'adhoc_no_stats',
        name: 'Adhoc query without stats',
        params: {},
      },
      {
        id: 's-timeout',
        label: 'slow_report',
        name: 'Slow execution (measurement timeout)',
        params: {delayMs: 5000},
      },
      {
        id: 's-boundary',
        label: 'boundary_estimate',
        name: 'Estimate error at threshold',
        params: {actualRows: 8000},
      },
      {
        id: 's-param-north',
        label: 'param_plan_switch',
        name: 'Selective region (parameter -> index scan)',
        params: {region: 'north'},
      },
      {
        id: 's-param-south',
        label: 'param_plan_switch',
        name: 'Broad region (parameter -> same seq scan)',
        params: {region: 'south'},
      },
    ],
  };
}

function defaultRules(): RuleSet {
  return {
    id: 'rs-default',
    name: 'Default gate rules',
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    defaults: {
      // By default, the new optimizer must preserve plan shape.
      structureChangeAllowed: false,
      maxEstErrorRatio: 0.25,
      measurementTimeoutMs: 200,
    },
    labels: [
      // The customer index rollout intentionally changes the plan shape; the
      // structure check is relaxed for this label only.
      {label: 'orders_by_customer', structureChangeAllowed: true},
    ],
  };
}
