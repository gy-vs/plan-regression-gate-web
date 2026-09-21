import type {
  GateRun,
  ParameterSet,
  RuleSet,
  RunEvent,
  Sample,
  StatsSnapshot,
} from '../shared/types';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {'content-type': 'application/json'},
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), {body, status: res.status});
  return body as T;
}

export const api = {
  state: () =>
    jsonFetch<{
      schemaRevision: number;
      stats: StatsSnapshot;
      parameterSets: ParameterSet[];
      ruleSets: RuleSet[];
      activeRuns: number;
      runCapacity: number;
    }>('/api/state'),

  saveSample: (setId: string, sample: Sample, revision: number) =>
    jsonFetch<ParameterSet>(`/api/parameter-sets/${setId}/samples`, {
      method: 'PUT',
      body: JSON.stringify({sample, revision}),
    }),

  deleteSample: (setId: string, sampleId: string, revision: number) =>
    jsonFetch<ParameterSet>(
      `/api/parameter-sets/${setId}/samples/${sampleId}?revision=${revision}`,
      {method: 'DELETE'},
    ),

  saveRules: (rules: RuleSet, revision: number) =>
    jsonFetch<RuleSet>(`/api/rules/${rules.id}`, {
      method: 'PUT',
      body: JSON.stringify({rules, revision}),
    }),

  refreshStats: () => jsonFetch<StatsSnapshot>('/api/stats/refresh', {method: 'POST', body: '{}'}),

  startRun: (parameterSetId: string, concurrency: number) =>
    jsonFetch<{runId: string; run: GateRun}>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({parameterSetId, concurrency}),
    }),

  run: (id: string) => jsonFetch<GateRun>(`/api/runs/${id}`),
  cancel: (id: string) => jsonFetch<{cancelling: boolean}>(`/api/runs/${id}/cancel`, {method: 'POST', body: '{}'}),
  publish: (id: string) => jsonFetch<{published: boolean; run: GateRun}>(`/api/runs/${id}/publish`, {method: 'POST', body: '{}'}),
};

/**
 * Subscribe to run events. Late subscribers automatically receive the
 * buffered history from the server. Returns a close() to detach.
 */
export function streamRun(
  runId: string,
  onEvent: (event: RunEvent) => void,
): {close: () => void} {
  const es = new EventSource(`/api/runs/${runId}/events`);
  es.onmessage = (message) => {
    const event = JSON.parse(message.data) as RunEvent;
    onEvent(event);
    if (event.type === 'done') es.close();
  };
  return {close: () => es.close()};
}
