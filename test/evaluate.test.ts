import { describe, expect, it } from 'vitest';
import {
  auditEstimation,
  effectiveThresholds,
  evaluateSample,
  structuralDiff,
  summarize,
} from '../src/server/evaluate';
import type { PlanNode, SampleResult } from '../src/server/types';

const node = (over: Partial<PlanNode> = {}): PlanNode => ({
  id: 'n',
  op: 'SeqScan',
  table: 'orders',
  estRows: 100,
  actualRows: 100,
  estCost: 1,
  children: [],
  ...over,
});

const baseInput = (over: Record<string, unknown> = {}) => ({
  legacyRoot: node(),
  newRoot: node(),
  legacyMs: 100,
  newMs: 100,
  thresholds: { maxStructuralDiff: 0, maxEstError: 0.1, maxRuntimeRatio: 1.5 },
  ...over,
});

describe('threshold boundaries are inclusive', () => {
  it('passes estimation error exactly at the threshold, fails just above', () => {
    const atLimit = evaluateSample(
      baseInput({ newRoot: node({ estRows: 110, actualRows: 100 }) }),
    );
    expect(atLimit.status).toBe('passed');
    expect(atLimit.maxEstError).toBeCloseTo(0.1, 10);

    const above = evaluateSample(
      baseInput({ newRoot: node({ estRows: 110.000001, actualRows: 100 }) }),
    );
    expect(above.status).toBe('failed');
    const check = above.checks.find((c) => c.name === 'estimation');
    expect(check?.status).toBe('fail');
    expect(check?.evidence).toMatchObject({ threshold: 0.1 });
  });

  it('passes runtime ratio exactly at the threshold, fails just above', () => {
    expect(evaluateSample(baseInput({ legacyMs: 100, newMs: 150 })).status).toBe('passed');
    const above = evaluateSample(baseInput({ legacyMs: 100, newMs: 150.000001 }));
    expect(above.status).toBe('failed');
    const check = above.checks.find((c) => c.name === 'measurement');
    expect(check?.evidence).toMatchObject({ legacyMs: 100, threshold: 1.5 });
  });

  it('passes structural diff count exactly at the threshold, fails above', () => {
    const legacy = node({ op: 'SeqScan' });
    const current = node({ op: 'IndexScan' });
    const atLimit = evaluateSample(baseInput({ legacyRoot: legacy, newRoot: current, thresholds: { maxStructuralDiff: 1, maxEstError: 0.1, maxRuntimeRatio: 1.5 } }));
    expect(atLimit.status).toBe('passed');
    expect(atLimit.structuralDiffCount).toBe(1);

    const above = evaluateSample(baseInput({ legacyRoot: legacy, newRoot: current }));
    expect(above.status).toBe('failed');
    const check = above.checks.find((c) => c.name === 'structure');
    expect(check?.evidence).toMatchObject({ diffCount: 1, threshold: 0 });
    expect(check?.evidence?.diffs).toEqual([
      { index: 0, legacy: 'SeqScan:orders', current: 'IndexScan:orders' },
    ]);
  });
});

describe('missing estimates', () => {
  it('fails with missing_estimate evidence when estRows is absent', () => {
    const result = evaluateSample(baseInput({ newRoot: node({ estRows: null }) }));
    expect(result.status).toBe('failed');
    const check = result.checks.find((c) => c.name === 'estimation');
    expect(check?.evidence).toMatchObject({ reason: 'missing_estimate', node: 'SeqScan:orders' });
  });

  it('fails with missing_actual evidence when actualRows is absent', () => {
    const result = evaluateSample(baseInput({ newRoot: node({ actualRows: null }) }));
    const check = result.checks.find((c) => c.name === 'estimation');
    expect(check?.evidence).toMatchObject({ reason: 'missing_actual' });
  });

  it('reports the missing node deep in the tree', () => {
    const root = node({ id: 'j', op: 'HashJoin', children: [node(), node({ id: 'leaf', estRows: null })] });
    const audit = auditEstimation(root);
    expect(audit.missing).toEqual({ node: 'SeqScan:orders', reason: 'missing_estimate' });
  });
});

describe('structural diff', () => {
  it('detects join reordering', () => {
    const legacy = node({
      op: 'HashJoin',
      table: 'items',
      children: [
        node({ op: 'HashJoin', table: 'customers', children: [node(), node({ table: 'customers' })] }),
        node({ table: 'items' }),
      ],
    });
    const current = node({
      op: 'HashJoin',
      table: 'customers',
      children: [
        node({ op: 'NestedLoop', table: 'items', children: [node(), node({ table: 'items' })] }),
        node({ table: 'customers' }),
      ],
    });
    const diff = structuralDiff(legacy, current);
    expect(diff.count).toBeGreaterThan(0);
    expect(diff.diffs[0]).toMatchObject({ index: 0 });
  });
});

describe('label overrides', () => {
  const rules = {
    defaults: { maxStructuralDiff: 0, maxEstError: 0.25, maxRuntimeRatio: 3 },
    overrides: {
      oltp: { maxStructuralDiff: 2 },
      bulk: { maxEstError: 1 },
    },
  };

  it('merges overrides for matching labels in order', () => {
    expect(effectiveThresholds(rules, ['oltp']).thresholds).toEqual({
      maxStructuralDiff: 2,
      maxEstError: 0.25,
      maxRuntimeRatio: 3,
    });
    expect(effectiveThresholds(rules, ['bulk', 'oltp']).thresholds).toEqual({
      maxStructuralDiff: 2,
      maxEstError: 1,
      maxRuntimeRatio: 3,
    });
  });

  it('ignores unknown labels', () => {
    const { thresholds, applied } = effectiveThresholds(rules, ['nope']);
    expect(thresholds).toEqual(rules.defaults);
    expect(applied).toEqual([]);
  });
});

describe('summarize uses valid pairs only', () => {
  it('excludes invalid and skipped samples from aggregates', () => {
    const results: SampleResult[] = [
      { index: 0, sampleId: 'a', name: 'a', labels: [], status: 'passed', maxEstError: 0.1, runtimeRatio: 1.1, structuralDiffCount: 0 },
      { index: 1, sampleId: 'b', name: 'b', labels: [], status: 'failed', maxEstError: 0.4, runtimeRatio: 2, structuralDiffCount: 1 },
      { index: 2, sampleId: 'c', name: 'c', labels: [], status: 'invalid', maxEstError: 99, runtimeRatio: 99 },
      { index: 3, sampleId: 'd', name: 'd', labels: [], status: 'skipped' },
    ];
    const summary = summarize(results);
    expect(summary).toMatchObject({
      total: 4,
      validPairs: 2,
      passed: 1,
      failed: 1,
      invalid: 1,
      skipped: 1,
      structuralChanges: 1,
    });
    // Aggregates ignore the invalid sample's placeholder values.
    expect(summary.maxEstError).toBe(0.4);
    expect(summary.maxRuntimeRatio).toBe(2);
  });
});
