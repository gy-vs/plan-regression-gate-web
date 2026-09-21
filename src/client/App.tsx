import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Play, Plus, Save, Square, Upload } from 'lucide-react';
import type {
  GateRun,
  ParamSet,
  RulesSnapshot,
  SampleResult,
  StatsSnapshot,
} from '../server/types';

const STATUS_LABEL: Record<SampleResult['status'], string> = {
  pending: '等待',
  running: '运行中',
  passed: '通过',
  failed: '失败',
  invalid: '无效',
  skipped: '未运行',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error ?? `HTTP ${response.status}`) as Error & {
      status?: number;
      body?: unknown;
    };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body as T;
}

const jsonInit = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

export default function App() {
  const [sets, setSets] = useState<ParamSet[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [detail, setDetail] = useState<ParamSet | null>(null);
  const [draft, setDraft] = useState('');
  const [rules, setRules] = useState<RulesSnapshot | null>(null);
  const [rulesDraft, setRulesDraft] = useState('');
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [statsDraft, setStatsDraft] = useState('');
  const [run, setRun] = useState<GateRun | null>(null);
  const [notice, setNotice] = useState('就绪');
  const eventSource = useRef<EventSource | null>(null);

  useEffect(() => {
    void loadSets();
    void loadRules();
    void loadStats();
    return () => eventSource.current?.close();
  }, []);

  useEffect(() => {
    if (!selected) return;
    void selectSet(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function loadSets() {
    const list = await api<ParamSet[]>('/api/param-sets');
    setSets(list);
    setSelected((current) => current || list[0]?.id || '');
  }

  async function selectSet(id: string) {
    setNotice('加载参数集…');
    eventSource.current?.close();
    const value = await api<ParamSet>(`/api/param-sets/${id}`);
    setDetail(value);
    setDraft(JSON.stringify({ name: value.name, query: value.query, samples: value.samples }, null, 2));
    const runs = await api<GateRun[]>('/api/gates');
    const latest = runs.filter((r) => r.paramSetId === id).at(-1) ?? null;
    setRun(latest);
    if (latest?.status === 'running') attachEvents(latest.id);
    setNotice('就绪');
  }

  async function loadRules() {
    const value = await api<RulesSnapshot>('/api/rules');
    setRules(value);
    setRulesDraft(JSON.stringify({ defaults: value.defaults, overrides: value.overrides }, null, 2));
  }

  async function loadStats() {
    const value = await api<StatsSnapshot>('/api/stats');
    setStats(value);
    setStatsDraft(JSON.stringify({ tables: value.tables }, null, 2));
  }

  function attachEvents(runId: string) {
    eventSource.current?.close();
    const source = new EventSource(`/api/gates/${runId}/events`);
    eventSource.current = source;
    source.addEventListener('snapshot', (event) => {
      setRun(JSON.parse((event as MessageEvent).data) as GateRun);
    });
    source.addEventListener('sample', (event) => {
      const { result } = JSON.parse((event as MessageEvent).data) as { result: SampleResult };
      // Results stream in completion order; place them back into the original
      // sample order by index.
      setRun((prev) =>
        prev
          ? { ...prev, samples: prev.samples.map((s) => (s.index === result.index ? result : s)) }
          : prev,
      );
    });
    source.addEventListener('done', (event) => {
      const { run: finished } = JSON.parse((event as MessageEvent).data) as { run: GateRun };
      setRun(finished);
      source.close();
      setNotice(
        finished.status === 'cancelled'
          ? '已取消'
          : finished.decision === 'passed'
            ? '门控通过'
            : '门控未通过',
      );
    });
  }

  async function saveSet() {
    if (!detail) return;
    try {
      const parsed = JSON.parse(draft);
      const updated = await api<ParamSet>(
        `/api/param-sets/${detail.id}`,
        jsonInit('PUT', { revision: detail.revision, ...parsed }),
      );
      setDetail(updated);
      setNotice(`已保存（revision ${updated.revision}）`);
      void loadSets();
    } catch (err) {
      setNotice(err instanceof SyntaxError ? 'JSON 解析失败' : '保存失败：revision 冲突，请刷新后重试');
    }
  }

  async function createSet() {
    const created = await api<ParamSet>(
      '/api/param-sets',
      jsonInit('POST', {
        name: '新参数集',
        query: { base: 'orders', joins: [], filters: [], labels: [] },
        samples: [{ id: 's1', name: '样例 1', params: {} }],
      }),
    );
    await loadSets();
    setSelected(created.id);
  }

  async function saveRules() {
    if (!rules) return;
    try {
      const parsed = JSON.parse(rulesDraft);
      const updated = await api<RulesSnapshot>(
        '/api/rules',
        jsonInit('PUT', { revision: rules.revision, ...parsed }),
      );
      setRules(updated);
      setNotice(`规则已保存（revision ${updated.revision}）`);
    } catch (err) {
      setNotice(err instanceof SyntaxError ? 'JSON 解析失败' : '规则保存失败：revision 冲突');
    }
  }

  async function saveStats() {
    if (!stats) return;
    try {
      const parsed = JSON.parse(statsDraft);
      const updated = await api<StatsSnapshot>(
        '/api/stats',
        jsonInit('PUT', { revision: stats.revision, ...parsed }),
      );
      setStats(updated);
      setNotice(`统计已保存（revision ${updated.revision}）`);
    } catch (err) {
      setNotice(err instanceof SyntaxError ? 'JSON 解析失败' : '统计保存失败：revision 冲突');
    }
  }

  async function runGate() {
    if (!detail) return;
    setNotice('门控运行中…');
    const created = await api<GateRun>('/api/gates', jsonInit('POST', { paramSetId: detail.id }));
    setRun(created);
    attachEvents(created.id);
  }

  async function cancelGate() {
    if (!run) return;
    await api<GateRun>(`/api/gates/${run.id}/cancel`, { method: 'POST' });
    setNotice('已请求取消');
  }

  async function publish() {
    if (!run) return;
    try {
      await api(`/api/gates/${run.id}/publish`, { method: 'POST' });
      setNotice('已发布');
      const fresh = await api<GateRun>(`/api/gates/${run.id}`);
      setRun(fresh);
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setNotice(
        body?.error === 'stale_rules_revision'
          ? '规则已更新，旧运行不能发布到新规则 revision'
          : body?.error === 'run_not_completed'
            ? '运行未结束，不能发布'
            : '发布失败',
      );
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>查询计划回归门控</strong>
        <small>
          统计 r{stats?.revision ?? '-'} · 规则 r{rules?.revision ?? '-'}
        </small>
        <span className="notice">{notice}</span>
      </header>
      <section className="workspace">
        <aside className="pane">
          <div className="pane-title">
            <h2>参数集</h2>
            <button onClick={createSet} title="新建参数集">
              <Plus size={14} />
            </button>
          </div>
          <div className="list">
            {sets.map((item) => (
              <button
                key={item.id}
                className={item.id === selected ? 'active' : ''}
                onClick={() => setSelected(item.id)}
              >
                {item.name}
                <br />
                <small>
                  {item.samples.length} 个样例 · revision {item.revision}
                </small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={saveSet} disabled={!detail}>
              <Save size={15} />
              保存参数集
            </button>
            <button className="primary" onClick={runGate} disabled={!detail || run?.status === 'running'}>
              <Play size={15} />
              运行门控
            </button>
            <button onClick={cancelGate} disabled={run?.status !== 'running'}>
              <Square size={15} />
              取消
            </button>
          </div>
          <textarea
            aria-label="参数集定义"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
          />
          <details>
            <summary>阈值规则（按标签覆盖）</summary>
            <textarea
              aria-label="阈值规则"
              className="short"
              value={rulesDraft}
              onChange={(event) => setRulesDraft(event.target.value)}
              spellCheck={false}
            />
            <button onClick={saveRules}>
              <Save size={14} />
              保存规则
            </button>
          </details>
          <details>
            <summary>统计信息（revision {stats?.revision ?? '-'}）</summary>
            <textarea
              aria-label="统计信息"
              className="short"
              value={statsDraft}
              onChange={(event) => setStatsDraft(event.target.value)}
              spellCheck={false}
            />
            <button onClick={saveStats}>
              <Save size={14} />
              保存统计
            </button>
          </details>
        </section>

        <aside className="pane">
          <div className="pane-title">
            <h2>门控运行</h2>
            {run && (
              <button
                onClick={publish}
                disabled={run.status !== 'completed' || Boolean(run.publishedAt)}
                title="发布到当前规则 revision"
              >
                <Upload size={14} />
                {run.publishedAt ? '已发布' : '发布'}
              </button>
            )}
          </div>
          {!run && <p className="muted">尚未运行门控。</p>}
          {run && (
            <>
              <div className="run-meta">
                <span className={`pill st-${run.status}`}>
                  {run.status === 'running' ? '运行中' : run.status === 'completed' ? '已完成' : '已取消'}
                </span>
                {run.decision && (
                  <span className={`pill st-${run.decision === 'passed' ? 'passed' : 'failed'}`}>
                    {run.decision === 'passed' ? '判定通过' : '判定失败'}
                  </span>
                )}
                <small>
                  参数集 r{run.paramSetRevision} · 统计 r{run.statsRevision} · 规则 r{run.rulesRevision}
                </small>
              </div>
              {run.summary && (
                <dl className="summary">
                  <div>
                    <dt>有效成对</dt>
                    <dd>
                      {run.summary.validPairs}/{run.summary.total}
                    </dd>
                  </div>
                  <div>
                    <dt>通过</dt>
                    <dd>{run.summary.passed}</dd>
                  </div>
                  <div>
                    <dt>失败</dt>
                    <dd>{run.summary.failed}</dd>
                  </div>
                  <div>
                    <dt>无效</dt>
                    <dd>{run.summary.invalid}</dd>
                  </div>
                  <div>
                    <dt>未运行</dt>
                    <dd>{run.summary.skipped}</dd>
                  </div>
                  <div>
                    <dt>结构变化</dt>
                    <dd>{run.summary.structuralChanges}</dd>
                  </div>
                  <div>
                    <dt>最大估算误差</dt>
                    <dd>{run.summary.maxEstError === null ? '—' : run.summary.maxEstError.toFixed(3)}</dd>
                  </div>
                  <div>
                    <dt>最大耗时比</dt>
                    <dd>{run.summary.maxRuntimeRatio === null ? '—' : run.summary.maxRuntimeRatio.toFixed(2)}</dd>
                  </div>
                </dl>
              )}
              <ol className="results">
                {run.samples.map((sample) => (
                  <li key={sample.sampleId} className={`result st-${sample.status}`}>
                    <div className="result-head">
                      <span className={`pill st-${sample.status}`}>{STATUS_LABEL[sample.status]}</span>
                      <strong>{sample.name}</strong>
                      <small>#{sample.index + 1}</small>
                    </div>
                    {sample.reason && <code className="evidence">{JSON.stringify(sample.reason)}</code>}
                    {sample.checks
                      ?.filter((check) => check.status === 'fail')
                      .map((check) => (
                        <div key={check.name} className="check-fail">
                          <span>{check.name}</span>
                          <code className="evidence">{JSON.stringify(check.evidence)}</code>
                        </div>
                      ))}
                  </li>
                ))}
              </ol>
            </>
          )}
        </aside>
      </section>
    </main>
  );
}
