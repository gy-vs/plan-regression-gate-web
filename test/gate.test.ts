import {describe, expect, it} from 'vitest';
import {evaluateSample, effectiveRule} from '../src/server/gate';
import {defaultMeasure, type MeasureFn} from '../src/server/measurement';
import {initialStats} from '../src/server/schema';
import type {RuleSet, Sample} from '../src/shared/types';

function sample(partial: Partial<Sample> & Pick<Sample, 'id' | 'label'>): Sample {
  return {name: partial.id, params: {}, ...partial};
}

function rules(partial: Partial<RuleSet> = {}): RuleSet {
  return {
    id: 'rs',
    name: 'test',
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    defaults: {
      structureChangeAllowed: false,
      maxEstErrorRatio: 0.25,
      measurementTimeoutMs: 50,
    },
    labels: [],
    ...partial,
  };
}

async function run(s: Sample, r: RuleSet, measure: MeasureFn = defaultMeasure) {
  const {result} = await evaluateSample(s, 0, {
    rules: r,
    stats: initialStats(),
    measure,
    enableMeasurement: true,
  });
  return result;
}

describe('effectiveRule label overrides', () => {
  it('falls back to defaults and applies label overrides', () => {
    const r = rules({
      labels: [
        {label: 'orders_by_customer', structureChangeAllowed: true, maxEstErrorRatio: 0.9},
      ],
    });
    expect(effectiveRule(r, 'customer_lookup').structureChangeAllowed).toBe(false);
    expect(effectiveRule(r, 'orders_by_customer').structureChangeAllowed).toBe(true);
    expect(effectiveRule(r, 'orders_by_customer').maxEstErrorRatio).toBe(0.9);
  });
});

describe('structure gate', () => {
  it('fails when parameters force a different plan on the new optimizer', async () => {
    const r = rules();
    const result = await run(sample({id: 'x', label: 'param_plan_switch', params: {region: 'north'}}), r);
    expect(result.status).toBe('failed');
    const structure = result.labels[0].checks.find((c) => c.name === 'structure');
    expect(structure?.passed).toBe(false);
    expect(structure?.evidence).toContain('plan shape changed');
  });

  it('passes the same label under a per-label structure override', async () => {
    const r = rules({
      labels: [{label: 'param_plan_switch', structureChangeAllowed: true}],
    });
    const result = await run(sample({id: 'x', label: 'param_plan_switch', params: {region: 'north'}}), r);
    const structure = result.labels[0].checks.find((c) => c.name === 'structure');
    expect(structure?.passed).toBe(true);
  });

  it('passes when the parameter keeps both plan shapes identical', async () => {
    const result = await run(
      sample({id: 'x', label: 'param_plan_switch', params: {region: 'south'}}),
      rules(),
    );
    const structure = result.labels[0].checks.find((c) => c.name === 'structure');
    expect(structure?.passed).toBe(true);
  });
});

describe('estimated rows gate', () => {
  it('fails with concrete evidence when estimates are missing', async () => {
    const result = await run(sample({id: 'x', label: 'adhoc_no_stats'}), rules());
    const check = result.labels[0].checks.find((c) => c.name === 'estimated_rows');
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain('estimated rows missing');
    expect(result.validPair).toBe(false);
    expect(result.estErrorRatio).toBeNull();
  });

  it('ratio exactly at the threshold passes; just over fails', async () => {
    // est 10000 vs actual 8000 -> ratio 0.25 exactly (inclusive boundary).
    const atBoundary = await run(
      sample({id: 'a', label: 'boundary_estimate', params: {actualRows: 8000}}),
      rules(),
    );
    const atCheck = atBoundary.labels[0].checks.find((c) => c.name === 'estimated_rows');
    expect(atCheck?.passed).toBe(true);
    expect(atCheck?.details?.ratio).toBeCloseTo(0.25, 5);

    const over = await run(
      sample({id: 'b', label: 'boundary_estimate', params: {actualRows: 7999}}),
      rules(),
    );
    const overCheck = over.labels[0].checks.find((c) => c.name === 'estimated_rows');
    expect(overCheck?.passed).toBe(false);
    expect(overCheck?.evidence).toContain('exceeds threshold');
  });
});

describe('measurement gate', () => {
  it('reports a measurement timeout as a label error with evidence', async () => {
    const slow: MeasureFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {actualRows: 1, elapsedMs: 100};
    };
    const result = await run(sample({id: 'x', label: 'customer_lookup'}), rules(), slow);
    expect(result.status).toBe('failed');
    expect(result.labels[0].error?.kind).toBe('measurement_timeout');
    expect(result.labels[0].error?.message).toContain('50ms');
  });

  it('accepts a fast injected measurement', async () => {
    const fast: MeasureFn = async () => ({actualRows: 1, elapsedMs: 1});
    const result = await run(sample({id: 'x', label: 'customer_lookup'}), rules(), fast);
    expect(result.status).toBe('passed');
    expect(result.labels[0].measurement?.actualRows).toBe(1);
  });
});

describe('partial failures', () => {
  it('one failing check does not mask other checks in the same sample', async () => {
    const r = rules();
    // Identical shapes, measurement succeeds, but the new estimate 10000 vs
    // actual 1 gives ratio 9 -> only the estimated_rows check fails.
    const result = await run(
      sample({id: 'x', label: 'boundary_estimate', params: {actualRows: 1}}),
      r,
    );
    const checks = Object.fromEntries(result.labels[0].checks.map((c) => [c.name, c]));
    expect(checks.structure.passed).toBe(true);
    expect(checks.estimated_rows.passed).toBe(false);
    expect(checks.estimated_rows.evidence).toContain('new est error ratio');
    expect(checks.measurement.passed).toBe(true);
  });

  it('a better new estimate passes even when the old estimate was far off', async () => {
    // Old seq scan guesses 100000; new index estimates 10000; actual 10000.
    const result = await run(
      sample({id: 'x', label: 'param_plan_switch', params: {region: 'north'}}),
      rules({labels: [{label: 'param_plan_switch', structureChangeAllowed: true}]}),
    );
    const check = result.labels[0].checks.find((c) => c.name === 'estimated_rows');
    expect(check?.passed).toBe(true);
    expect(check?.details?.ratio).toBe(0);
    expect(check?.details?.oldRatio).toBe(9);
  });
});
