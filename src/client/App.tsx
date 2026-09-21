import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  FlaskConical,
  Play,
  Save,
  X,
  Upload,
  RefreshCw,
  Plus,
  Trash2,
} from 'lucide-react';
import {api, streamRun} from './api';
import type {
  CatalogInfo,
  GateRun,
  ParameterSet,
  RuleSet,
  RunEvent,
  Sample,
  SampleResult,
} from '../shared/types';

type State = Awaited<ReturnType<typeof api.state>>;

const EMPTY_DRAFT: Sample = {id: '', label: 'customer_lookup', name: '', params: {}};

function statusClass(status: string): string {
  if (status === 'passed') return 'ok';
  if (status === 'failed') return 'bad';
  return 'skip';
}

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [catalog, setCatalog] = useState<CatalogInfo | null>(null);
  const [run, setRun] = useState<GateRun | null>(null);
  const [streamingOrder, setStreamingOrder] = useState<number[]>([]);
  const [draft, setDraft] = useState<Sample>(EMPTY_DRAFT);
  const [editorKey, setEditorKey] = useState(0);
  const [rulesDraft, setRulesDraft] = useState<RuleSet | null>(null);
  const [concurrency, setConcurrency] = useState(4);
  const [message, setMessage] = useState('Ready');
  const [publishError, setPublishError] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<SampleResult | null>(null);
  const streamRef = useRef<{close: () => void} | null>(null);

  useEffect(() => {
    fetch('/api/catalog').then((r) => r.json()).then(setCatalog);
    api.state().then((s) => {
      setState(s);
      setRulesDraft(s.ruleSets[0]);
    });
  }, []);

  const parameterSet = state?.parameterSets[0] ?? null;

  const handleEvent = useCallback((event: RunEvent) => {
    if (event.type === 'sample') {
      setStreamingOrder((order) => [...order, event.result.index]);
      setRun((current) => {
        if (!current) return current;
        const results = [...current.results];
        results[event.result.index] = event.result;
        return {...current, results};
      });
    } else if (event.type === 'done') {
      setRun(event.run);
      setMessage(event.run.status === 'cancelled' ? 'Run cancelled' : 'Run completed');
    }
  }, []);

  const startRun = async () => {
    if (!parameterSet) return;
    if (state && state.activeRuns >= state.runCapacity) {
      setMessage(`Capacity reached (${state.activeRuns}/${state.runCapacity} gates running)`);
      return;
    }
    setPublishError(null);
    setSelectedResult(null);
    setStreamingOrder([]);
    try {
      const {runId, run: initial} = await api.startRun(parameterSet.id, concurrency);
      setRun(initial);
      setMessage('Gate running…');
      streamRef.current?.close();
      streamRef.current = streamRun(runId, handleEvent);
      // Refresh active-run count.
      api.state().then(setState);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to start');
    }
  };

  const cancelRun = async () => {
    if (!run) return;
    await api.cancel(run.id).catch(() => undefined);
    setMessage('Cancelling…');
  };

  const publishRun = async () => {
    if (!run) return;
    setPublishError(null);
    try {
      const {run: published} = await api.publish(run.id);
      setRun(published);
      setMessage('Published');
    } catch (err) {
      const error = err as {body?: {error?: string; currentRuleRevision?: number}};
      setPublishError(error.body?.error ?? 'Publish rejected');
    }
  };

  const refreshStats = async () => {
    const stats = await api.refreshStats();
    setState((s) => (s ? {...s, stats} : s));
    setMessage(`Stats updated to revision ${stats.revision}`);
  };

  const saveSample = async () => {
    if (!parameterSet || !draft.id || !draft.name) return;
    try {
      const updated = await api.saveSample(parameterSet.id, draft, parameterSet.revision);
      setState((s) =>
        s ? {...s, parameterSets: s.parameterSets.map((p) => (p.id === updated.id ? updated : p))} : s,
      );
      setDraft(EMPTY_DRAFT);
      setEditorKey((k) => k + 1);
      setMessage(`Saved ${draft.id} (revision ${updated.revision})`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const saveRules = async () => {
    if (!rulesDraft || !state) return;
    try {
      const current = state.ruleSets[0];
      const updated = await api.saveRules(rulesDraft, current.revision);
      setState((s) =>
        s ? {...s, ruleSets: s.ruleSets.map((r) => (r.id === updated.id ? updated : r))} : s,
      );
      setRulesDraft(updated);
      setMessage(`Rules updated to revision ${updated.revision}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Rules save failed');
    }
  };

  const removeSample = async (sample: Sample) => {
    if (!parameterSet) return;
    const updated = await api.deleteSample(parameterSet.id, sample.id, parameterSet.revision);
    setState((s) =>
      s ? {...s, parameterSets: s.parameterSets.map((p) => (p.id === updated.id ? updated : p))} : s,
    );
  };

  const running = run?.status === 'running';

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Plan Regression Gate</strong>
        <small>
          schema rev {state?.schemaRevision ?? '–'} · stats rev {state?.stats.revision ?? '–'} ·
          rules rev {state?.ruleSets[0].revision ?? '–'} · gates {state?.activeRuns ?? 0}/{state?.runCapacity ?? 2}
        </small>
        <button className="ghost" onClick={refreshStats} title="Refresh statistics (bumps revision)">
          <RefreshCw size={14} /> Refresh stats
        </button>
      </header>

      <section className="workspace">
        <aside className="pane">
          <h2>Parameter samples</h2>
          <p className="hint">
            {parameterSet?.name} · revision {parameterSet?.revision}
          </p>
          <div className="list">
            {parameterSet?.samples.map((sample) => (
              <div className="sample-row" key={sample.id}>
                <div>
                  <strong>{sample.name}</strong>
                  <br />
                  <small>
                    {sample.label} · {Object.keys(sample.params).length} param(s)
                  </small>
                </div>
                <button
                  className="icon"
                  disabled={running}
                  onClick={() => removeSample(sample)}
                  title="Delete sample"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          <h3>Add sample</h3>
          <div className="form">
            <input
              placeholder="sample id"
              value={draft.id}
              disabled={running}
              onChange={(e) => {
                setDraft({...draft, id: e.target.value});
              }}
            />
            <input
              placeholder="name"
              value={draft.name}
              disabled={running}
              onChange={(e) => setDraft({...draft, name: e.target.value})}
            />
            <select
              value={draft.label}
              disabled={running}
              onChange={(e) => setDraft({...draft, label: e.target.value})}
            >
              {catalog?.labels.map((label) => (
                <option key={label.label} value={label.label}>
                  {label.label}
                </option>
              ))}
            </select>
            <ParamEditor
              key={editorKey}
              value={draft.params}
              disabled={running}
              onChange={(params) => {
                setDraft({...draft, params});
              }}
            />
            <button className="primary" disabled={running || !draft.id || !draft.name} onClick={saveSample}>
              <Plus size={15} /> Save sample
            </button>
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <label>
              Concurrency
              <input
                type="number"
                min={1}
                max={8}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                disabled={running}
              />
            </label>
            <button className="primary" onClick={startRun} disabled={running}>
              <Play size={15} /> Run gate
            </button>
            <button onClick={cancelRun} disabled={!running}>
              <X size={15} /> Cancel
            </button>
            <button
              onClick={publishRun}
              disabled={!run || run.status !== 'completed' || !!run.published}
              title="Publish only against the exact rule revision this run used"
            >
              <Upload size={15} /> {run?.published ? 'Published' : 'Publish'}
            </button>
            <span className={`status-msg ${publishError ? 'bad' : ''}`}>
              {publishError ?? message}
            </span>
          </div>

          <RunTable run={run} streamingOrder={streamingOrder} onSelect={setSelectedResult} />
          {run?.summary && <SummaryBar run={run} />}
        </section>

        <aside className="pane details">
          <h2>Details</h2>
          {selectedResult ? (
            <ResultDetails result={selectedResult} />
          ) : (
            <RulesEditor rules={rulesDraft} onChange={setRulesDraft} onSave={saveRules} disabled={running} />
          )}
        </aside>
      </section>
    </main>
  );
}

function RunTable({
  run,
  streamingOrder,
  onSelect,
}: {
  run: GateRun | null;
  streamingOrder: number[];
  onSelect: (result: SampleResult) => void;
}) {
  // The table always renders in declared sample order even though result
  // events stream in as workers finish.
  const streamRank = useMemo(() => {
    const map = new Map<number, number>();
    streamingOrder.forEach((index, rank) => map.set(index, rank + 1));
    return map;
  }, [streamingOrder]);

  if (!run) return <p className="hint">No gate run yet.</p>;

  return (
    <table className="results">
      <thead>
        <tr>
          <th>#</th>
          <th>Sample</th>
          <th>Label</th>
          <th>Status</th>
          <th>Valid pair</th>
          <th>Est err</th>
          <th>Streamed</th>
        </tr>
      </thead>
      <tbody>
        {run.results.map((result, index) => (
          <tr
            key={index}
            className={result ? 'clickable' : 'pending-row'}
            onClick={() => result && onSelect(result)}
          >
            <td>{index + 1}</td>
            <td>{result?.name ?? '…'}</td>
            <td>{result?.label ?? '—'}</td>
            <td>
              {result ? (
                <span className={`badge ${statusClass(result.status)}`}>
                  {result.notRun ? 'not run' : result.status}
                </span>
              ) : (
                <span className="badge pending">pending</span>
              )}
            </td>
            <td>{result ? (result.validPair ? 'yes' : 'no') : '—'}</td>
            <td>{result?.estErrorRatio != null ? result.estErrorRatio.toFixed(4) : '—'}</td>
            <td>{streamRank.get(index) ? `#${streamRank.get(index)}` : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SummaryBar({run}: {run: GateRun}) {
  const s = run.summary!;
  return (
    <div className={`summary ${s.passed ? 'ok-bg' : 'bad-bg'}`}>
      <strong>{s.passed ? 'GATE PASSED' : 'GATE FAILED'}</strong>
      <span>
        {s.totalSamples} samples · {s.validPairs} valid pairs · {s.failedPairs} failed · {s.excluded}{' '}
        excluded (invalid pairs) · {s.notRun} not run
      </span>
      <span>
        max est error (valid pairs only):{' '}
        {s.maxEstErrorRatio == null ? 'n/a' : s.maxEstErrorRatio.toFixed(4)}
      </span>
      <span>
        run rules rev {run.ruleRevision} · stats rev {run.statsRevision} · status {run.status}
      </span>
    </div>
  );
}

function ResultDetails({result}: {result: SampleResult}) {
  const label = result.labels[0];
  return (
    <div>
      <h3>{result.name}</h3>
      <p className="hint">
        {result.label} · params {JSON.stringify(result.params)}
      </p>
      {label?.error && (
        <div className="evidence">
          <strong>{label.error.kind}</strong>: {label.error.message}
        </div>
      )}
      {label?.checks.map((check) => (
        <div key={check.name} className={`check ${check.passed ? 'ok' : 'bad'}`}>
          <span className={`badge ${check.passed ? 'ok' : 'bad'}`}>{check.name}</span>
          {check.evidence && <p className="evidence">{check.evidence}</p>}
          {check.details && <pre>{JSON.stringify(check.details, null, 2)}</pre>}
        </div>
      ))}
      {label?.measurement && (
        <p className="hint">
          measured {label.measurement.actualRows} rows in {label.measurement.elapsedMs}ms
        </p>
      )}
      {label?.oldRoot && (
        <details open>
          <summary>Old plan</summary>
          <pre>{JSON.stringify(label.oldRoot, null, 2)}</pre>
        </details>
      )}
      {label?.newRoot && (
        <details open>
          <summary>New plan</summary>
          <pre>{JSON.stringify(label.newRoot, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function RulesEditor({
  rules,
  onChange,
  onSave,
  disabled,
}: {
  rules: RuleSet | null;
  onChange: (rules: RuleSet) => void;
  onSave: () => void;
  disabled: boolean;
}) {
  if (!rules) return null;
  const update = (patch: Partial<RuleSet['defaults']>) =>
    onChange({...rules, defaults: {...rules.defaults, ...patch}});
  const updateLabel = (index: number, patch: Partial<import('../shared/types').LabelRule>) =>
    onChange({
      ...rules,
      labels: rules.labels.map((label, i) => (i === index ? {...label, ...patch} : label)),
    });
  return (
    <div>
      <h2>Threshold rules <small>rev {rules.revision}</small></h2>
      <div className="form">
        <label>
          Structure change allowed (default)
          <input
            type="checkbox"
            checked={rules.defaults.structureChangeAllowed}
            disabled={disabled}
            onChange={(e) => update({structureChangeAllowed: e.target.checked})}
          />
        </label>
        <label>
          Max est error ratio
          <input
            type="number"
            step={0.01}
            value={rules.defaults.maxEstErrorRatio}
            disabled={disabled}
            onChange={(e) => update({maxEstErrorRatio: Number(e.target.value)})}
          />
        </label>
        <label>
          Measurement timeout (ms)
          <input
            type="number"
            step={10}
            value={rules.defaults.measurementTimeoutMs}
            disabled={disabled}
            onChange={(e) => update({measurementTimeoutMs: Number(e.target.value)})}
          />
        </label>
      </div>
      <h3>Per-label overrides</h3>
      {rules.labels.map((label, index) => (
        <div className="override" key={label.label}>
          <code>{label.label}</code>
          <label>
            allow shape change
            <input
              type="checkbox"
              checked={!!label.structureChangeAllowed}
              disabled={disabled}
              onChange={(e) => updateLabel(index, {structureChangeAllowed: e.target.checked})}
            />
          </label>
          <input
            type="number"
            step={0.01}
            placeholder="ratio override"
            value={label.maxEstErrorRatio ?? ''}
            disabled={disabled}
            onChange={(e) => updateLabel(index, {maxEstErrorRatio: e.target.value === '' ? undefined : Number(e.target.value)})}
          />
        </div>
      ))}
      <button className="primary" onClick={onSave} disabled={disabled}>
        <Save size={15} /> Save rules (new revision)
      </button>
      <p className="hint">Runs already finished cannot be published after rules move to a new revision.</p>
    </div>
  );
}

function ParamEditor({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, string | number | boolean>;
  onChange: (value: Record<string, string | number | boolean>) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(() =>
    Object.keys(value).length ? JSON.stringify(value) : '',
  );
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <textarea
        className="params"
        placeholder='{"region":"north","delayMs":50}'
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === '') {
            setError(null);
            onChange({});
            return;
          }
          try {
            const parsed = JSON.parse(e.target.value);
            setError(null);
            onChange(parsed);
          } catch {
            setError('Invalid JSON');
          }
        }}
      />
      {error && <small className="bad">{error}</small>}
    </>
  );
}
