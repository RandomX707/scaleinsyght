import { useEffect, useState } from 'react';
import { Badge, Button, Input, Table } from '@scaleinsyght/ui';
import './agents.css';

/**
 * Agents, matching docs/prototype/index.html (V.agents): your agent, the orchestrator, one collating agent per source
 * group proposed by the profiler, a connector agent per connection, the ID agent and its ID trace sub-agent, and the
 * governed agents table. Everything shown comes from the registry; nothing is illustrative.
 */
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
type Connection = { connectionId: string; connectorType: string; displayName: string; status: string };
type AgentData = {
  groups: Array<{ groupId: string; version: number; connectionId: string; connectorType: string }>;
  governed: Array<{ governedId: string; name: string; version: number; approvedBy: string | null; lastRunAt: string | null }>;
  idAgent?: { fields: number; matches: number; paths: number };
};
const TYPE: Record<string, string> = { postgres: 'PostgreSQL', sql_server: 'SQL Server', snowflake: 'Snowflake', excel: 'Excel', dbt: 'dbt', tableau: 'Tableau', power_bi: 'Power BI' };
const name = (connection: Connection | undefined) => connection?.displayName || 'Connected source';
const list = (items: string[]) => items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never';

/** Latest version of each governed agent, with its approval state. */
export function governedRows(rows: AgentData['governed']) {
  const latest = new Map<string, AgentData['governed'][number]>();
  for (const row of rows) { const current = latest.get(row.governedId); if (!current || row.version > current.version) latest.set(row.governedId, row); }
  const approved = new Map<string, number>();
  for (const row of rows) if (row.approvedBy) approved.set(row.governedId, Math.max(approved.get(row.governedId) ?? 0, row.version));
  return [...latest.values()].map((row) => ({ ...row, approvedVersion: approved.get(row.governedId) ?? null, pending: !row.approvedBy }));
}

export function AgentsScreen(props: { connections: Connection[]; request: Request }) {
  const [data, setData] = useState<AgentData | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [draftName, setDraftName] = useState(''); const [question, setQuestion] = useState('');
  const reload = () => props.request<AgentData>('/api/agents').then(setData);
  useEffect(() => { void reload().catch(() => setError('Agents could not be loaded.')); }, []);
  const active = props.connections.filter((item) => item.status === 'active');
  const byId = new Map(active.map((item) => [item.connectionId, item]));
  const groups = [...new Map((data?.groups ?? []).map((group) => [group.groupId, group])).keys()]
    .map((groupId) => ({ groupId, members: (data?.groups ?? []).filter((group) => group.groupId === groupId && byId.has(group.connectionId)).map((group) => byId.get(group.connectionId)!) }))
    .filter((group) => group.members.length);
  const governed = governedRows(data?.governed ?? []);
  async function create() {
    try {
      const result = await props.request<{ governedId: string; version: number }>('/api/governed-agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: draftName, question, sourceIds: active.map((item) => item.connectionId) }) });
      setMessage(`Draft version ${result.version} saved. A different member must approve it in the Approval matrix.`); setDraftName(''); setQuestion(''); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The draft could not be saved.'); }
  }
  async function run(governedId: string, version: number) {
    try { await props.request(`/api/governed-agents/${governedId}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version }) }); setMessage(`Governed run of version ${version} started.`); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The governed run could not be started.'); }
  }
  const agent = (title: string, detail: string, className = '') => <div className={`agent-node ${className}`.trim()}><b>{title}</b><span>{detail}</span></div>;
  return <section className="agents-page">
    <div className="page-heading"><div><h1>Agents</h1><p>One agent per connector, collating agents per group of related sources, one orchestrator, and your own agent in front.</p></div></div>
    {error && <p role="alert" className="error">{error}</p>}{message && <p role="status">{message}</p>}
    <article className="agent-tiers" aria-label="How the agents are arranged">
      {agent('Your agent', 'Learns your preferences', 'is-personal')}
      <span className="agent-down" aria-hidden="true">↓</span>
      {agent('Orchestrator agent', 'Plans and routes every question')}
      <span className="agent-down" aria-hidden="true">↓</span>
      {groups.length ? <div className="agent-groups">{groups.map((group) => <section className="agent-group" key={group.groupId} aria-label={`Collating agent for ${list(group.members.map(name))}`}>
        <div className="agent-group-head"><b>Collating agent · {list(group.members.map(name))}</b><Badge tone="muted">Proposed by profiler</Badge></div>
        <div className="agent-row">{group.members.map((member) => <div key={member.connectionId}>{agent(name(member), `${TYPE[member.connectorType] ?? member.connectorType} agent`)}</div>)}</div>
      </section>)}</div> : <p className="agent-empty">No connector agents yet. Add a connector and its agent is created when the connection test passes.</p>}
      <div className="agent-row agent-ids">
        {agent('ID agent', data?.idAgent ? `${data.idAgent.fields.toLocaleString('en-US')} ID ${data.idAgent.fields === 1 ? 'field' : 'fields'} · ${data.idAgent.matches.toLocaleString('en-US')} ${data.idAgent.matches === 1 ? 'match' : 'matches'} across sources` : 'Finds identifier fields', 'is-id')}
        {agent('ID trace agent', data?.idAgent ? `Sub-agent · ${data.idAgent.paths.toLocaleString('en-US')} ID ${data.idAgent.paths === 1 ? 'path' : 'paths'}` : 'Sub-agent', 'is-id')}
      </div>
    </article>
    <article className="agents-governed"><h2>Governed agents</h2><p>Saved, approved analyses that run step by step with no AI call at run time.</p>
      {governed.length ? <Table caption="Governed agents" headers={['Agent', 'Status', 'Last run', '']} rows={governed.map((row) => [
        row.name,
        row.pending ? <Badge key="s" tone="warn">Draft v{row.version} · needs approval</Badge> : <Badge key="s" tone="good">Approved v{row.version}</Badge>,
        when(row.lastRunAt),
        row.approvedVersion ? <Button key="r" size="small" onClick={() => void run(row.governedId, row.approvedVersion!)}>Run version {row.approvedVersion}</Button> : '',
      ])} /> : <p className="agent-empty">No governed agents yet.</p>}
      <details className="agents-new"><summary>New governed agent</summary>
        <div className="agents-new-form"><label>Name<Input value={draftName} onChange={(event) => setDraftName(event.target.value)} /></label>
          <label>Question<Input value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
          <Button disabled={!draftName.trim() || !question.trim() || !active.length} onClick={() => void create()}>Save draft version</Button>
          <p>A draft runs only after a different member approves it in the Approval matrix.</p></div>
      </details>
    </article>
  </section>;
}
