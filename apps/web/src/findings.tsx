import React, { useState } from 'react';
import { Badge, Button, EmptyState, Table } from '@scaleinsyght/ui';

export type Finding = { findingId: string; connectionId: string; sourceName: string; jobId: string; jobType: string; kind: string; subject: string; detail: Record<string, unknown>; foundAt: string; status: string; decidedAt: string | null };
export type Findings = { findings: Finding[]; lastNight: { jobIds: string[]; startedAt: string | null; connections: number; profiled: number; listed: number } };

const KIND: Record<string, { label: string; tone: 'primary' | 'good' | 'warn' | 'bad' | 'muted' }> = {
  schema_change: { label: 'Schema change', tone: 'bad' }, data_anomaly: { label: 'Data anomaly', tone: 'warn' }, new_tables: { label: 'New table', tone: 'primary' },
  probable_relationship: { label: 'Probable relationship', tone: 'warn' }, id_match: { label: 'ID match', tone: 'warn' }, sensitive_column: { label: 'Sensitive column', tone: 'bad' },
};
const count = (value: unknown) => Number(value ?? 0).toLocaleString('en-US');
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];

/** Plain words for one finding, written from its stored names and counts. */
export function findingText(finding: Finding): string {
  const detail = finding.detail;
  switch (finding.kind) {
    case 'schema_change':
      if (detail.change === 'dropped') return `${finding.subject} was dropped from the source.`;
      return `${finding.subject} changed: ${[list(detail.added).length ? `added ${list(detail.added).join(', ')}` : '', list(detail.removed).length ? `removed ${list(detail.removed).join(', ')}` : '',
        ...(Array.isArray(detail.retyped) ? (detail.retyped as Array<{ column: string; from: string; to: string }>).map((item) => `${item.column} changed from ${item.from} to ${item.to}`) : [])].filter(Boolean).join('; ')}.`;
    case 'data_anomaly': return `${finding.subject} went from ${count(detail.before)} to ${count(detail.after)} rows.`;
    case 'new_tables': return `New table ${finding.subject} with ${count(detail.columns)} ${Number(detail.columns) === 1 ? 'column' : 'columns'}${detail.rows === null || detail.rows === undefined ? '' : ` and ${count(detail.rows)} ${Number(detail.rows) === 1 ? 'row' : 'rows'}`}.`;
    case 'sensitive_column': return `${finding.subject} looks ${String(detail.tag)}, inferred from its name or value format. Confirm to keep it protected, or dismiss.`;
    case 'probable_relationship': return `${finding.subject} looks like a relationship${detail.explanation ? `: ${String(detail.explanation)}` : ''}. Approving records review only; it stays unverified.`;
    case 'id_match': return `${finding.subject} look like the same ID${detail.explanation ? `: ${String(detail.explanation)}` : ''}. Approving records review only; it stays unverified.`;
    default: return finding.subject;
  }
}

/** Approval matrix findings (prototype "Approval matrix"): last night's run, then findings by tab with Approve or Reject. */
export function FindingsPanel(props: { data: Findings; decide: (findingId: string, decision: 'approved' | 'rejected') => Promise<void>; refreshNow?: () => Promise<void> }) {
  const [tab, setTab] = useState<'night' | 'earlier' | 'all'>('night');
  const [busy, setBusy] = useState('');
  const lastNight = new Set(props.data.lastNight.jobIds);
  const shown = props.data.findings.filter((finding) => tab === 'all' || (tab === 'night' ? lastNight.has(finding.jobId) : !lastNight.has(finding.jobId)));
  const nightFindings = props.data.findings.filter((finding) => lastNight.has(finding.jobId));
  const alerts = nightFindings.filter((finding) => finding.status === 'open' && (finding.kind === 'schema_change' || finding.kind === 'sensitive_column')).length;
  const act = async (findingId: string, decision: 'approved' | 'rejected') => { setBusy(findingId); try { await props.decide(findingId, decision); } finally { setBusy(''); } };
  return <div className="findings">
    <article className="nightly-summary">
      <div><h2>Last night's run</h2>{props.data.lastNight.startedAt
        ? <p>{count(props.data.lastNight.connections)} {props.data.lastNight.connections === 1 ? 'source' : 'sources'} refreshed at {new Date(props.data.lastNight.startedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}: {count(props.data.lastNight.profiled)} changed objects profiled of {count(props.data.lastNight.listed)} listed.</p>
        : <p>No nightly refresh has run yet. Each source is refreshed once a day after it is added.</p>}</div>
      <Badge tone={alerts ? 'bad' : 'good'}>{alerts} open {alerts === 1 ? 'alert' : 'alerts'}</Badge>
      <div className="nightly-stats"><div><strong>{count(nightFindings.length)}</strong><span>findings last night</span></div><div><strong>{count(props.data.findings.filter((finding) => finding.status === 'open').length)}</strong><span>waiting for review</span></div><div><strong>{count(props.data.findings.filter((finding) => finding.status !== 'open').length)}</strong><span>reviewed</span></div></div>
      {props.refreshNow && <Button size="small" onClick={() => void props.refreshNow!()}>Run a refresh now</Button>}
    </article>
    <div className="findings-tabs" role="tablist" aria-label="Findings">{([['night', 'From last night'], ['earlier', 'Earlier'], ['all', 'All']] as const).map(([key, label]) =>
      <Button key={key} role="tab" size="small" aria-selected={tab === key} className={`findings-tab${tab === key ? ' on' : ''}`} onClick={() => setTab(key)}>{label}</Button>)}</div>
    {shown.length ? <Table caption="Findings" headers={['Finding', 'Kind', 'When found', 'Affects', '']} rows={shown.map((finding) => [
      <span key="t">{findingText(finding)}</span>, <Badge key="k" tone={KIND[finding.kind]?.tone ?? 'muted'}>{KIND[finding.kind]?.label ?? finding.kind}</Badge>,
      new Date(finding.foundAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), `${finding.sourceName} · ${finding.subject.split(' → ')[0]}`,
      finding.status === 'open' ? <span key="a" className="findings-actions"><Button size="small" variant="primary" disabled={busy === finding.findingId} onClick={() => void act(finding.findingId, 'approved')}>{finding.kind === 'sensitive_column' ? 'Confirm' : 'Approve'}</Button><Button size="small" disabled={busy === finding.findingId} onClick={() => void act(finding.findingId, 'rejected')}>{finding.kind === 'sensitive_column' ? 'Dismiss' : 'Reject'}</Button></span>
        : <Badge key="s" tone={finding.status === 'approved' ? 'good' : 'muted'}>{finding.status === 'approved' ? (finding.kind === 'sensitive_column' ? 'Confirmed' : 'Approved') : (finding.kind === 'sensitive_column' ? 'Dismissed' : 'Rejected')}</Badge>])} />
      : <EmptyState title={tab === 'night' ? 'Nothing found last night' : 'No findings here'} description="Findings appear when a refresh finds a schema change, a large row-count change, a new table, a sensitive column, a probable relationship or an ID match." />}
  </div>;
}
