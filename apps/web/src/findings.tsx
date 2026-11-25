import React, { useState } from 'react';
import { Badge, Button, EmptyState, Table } from '@scaleinsyght/ui';

export type Finding = { findingId: string; connectionId: string; sourceName: string; jobId: string; jobType: string; kind: string; subject: string; detail: Record<string, unknown>; foundAt: string; status: string; decidedAt: string | null };
export type Findings = { findings: Finding[]; lastNight: { jobIds: string[]; scheduled: boolean; startedAt: string | null; connections: number; profiled: number; listed: number } };

const KIND: Record<string, { label: string; tone: 'primary' | 'good' | 'warn' | 'bad' | 'muted' }> = {
  schema_change: { label: 'Schema change', tone: 'bad' }, data_anomaly: { label: 'Data anomaly', tone: 'warn' }, new_tables: { label: 'New table', tone: 'primary' },
  probable_relationship: { label: 'Probable relationship', tone: 'warn' }, id_match: { label: 'ID match', tone: 'warn' }, sensitive_column: { label: 'Sensitive column', tone: 'bad' },
};
const count = (value: unknown) => Number(value ?? 0).toLocaleString('en-US');
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];

/** Plain words for one finding, written from its stored names and counts. */
export function findingText(finding: Finding): string {
  const detail = finding.detail;
  const rawExplanation = typeof detail.explanation === 'string' ? detail.explanation.trim().replace(/[.]+$/, '') : '';
  const explanation = rawExplanation.toLowerCase() === 'source-local structural analysis'
    ? 'the columns appear to link tables within this source'
    : rawExplanation;
  switch (finding.kind) {
    case 'schema_change':
      if (detail.change === 'dropped') return `${finding.subject} was dropped from the source.`;
      return `${finding.subject} changed: ${[list(detail.added).length ? `added ${list(detail.added).join(', ')}` : '', list(detail.removed).length ? `removed ${list(detail.removed).join(', ')}` : '',
        ...(Array.isArray(detail.retyped) ? (detail.retyped as Array<{ column: string; from: string; to: string }>).map((item) => `${item.column} changed from ${item.from} to ${item.to}`) : [])].filter(Boolean).join('; ')}.`;
    case 'data_anomaly': return `${finding.subject} went from ${count(detail.before)} to ${count(detail.after)} rows.`;
    case 'new_tables': return `New table ${finding.subject} with ${count(detail.columns)} ${Number(detail.columns) === 1 ? 'column' : 'columns'}${detail.rows === null || detail.rows === undefined ? '' : ` and ${count(detail.rows)} ${Number(detail.rows) === 1 ? 'row' : 'rows'}`}.`;
    case 'sensitive_column': return `${finding.subject} looks ${String(detail.tag)}, inferred from its name or value format. Confirm to keep it protected, or dismiss.`;
    case 'probable_relationship': return `${finding.subject} looks like a relationship${explanation ? `: ${explanation}` : ''}.`;
    case 'id_match': return `${finding.subject} look like the same ID${explanation ? `: ${explanation}` : ''}.`;
    default: return finding.subject;
  }
}

export function findingSources(finding: Finding): string {
  if (finding.kind === 'id_match') {
    const {fromSource, fromField, toSource, toField} = finding.detail;
    if ([fromSource, fromField, toSource, toField].every(value => typeof value === 'string')) {
      return `${fromSource} · ${fromField} ↔ ${toSource} · ${toField}`;
    }
    return finding.subject;
  }
  return `${finding.sourceName} · ${finding.subject.split(' → ')[0]}`;
}

export function findingGroup(kind: string): 'Changes' | 'Suggestions' {
  return ['probable_relationship', 'id_match', 'sensitive_column'].includes(kind) ? 'Suggestions' : 'Changes';
}

/** Approval matrix findings (prototype "Approval matrix"): last night's run, then findings by tab with Approve or Reject. */
export function FindingsPanel(props: { data: Findings; decide: (findingId: string, decision: 'approved' | 'rejected') => Promise<void>; refreshNow?: () => Promise<void> }) {
  const [tab, setTab] = useState<'night' | 'earlier' | 'all'>('night');
  const [busy, setBusy] = useState('');
  const [group, setGroup] = useState<'Changes' | 'Suggestions'>('Changes');
  const lastNight = new Set(props.data.lastNight.jobIds);
  const shown = props.data.findings.filter((finding) => findingGroup(finding.kind) === group).filter((finding) => tab === 'all' || (tab === 'night' ? lastNight.has(finding.jobId) : !lastNight.has(finding.jobId)));
  const nightFindings = props.data.findings.filter((finding) => lastNight.has(finding.jobId));
  const alerts = props.data.findings.filter((finding) => finding.status === 'open').length;
  const act = async (findingId: string, decision: 'approved' | 'rejected') => { setBusy(findingId); try { await props.decide(findingId, decision); } finally { setBusy(''); } };
  const pending = shown.filter(finding => finding.status === 'open');
  const approveGroup = async () => {
    setBusy('group');
    try {
      for (const finding of pending) await props.decide(finding.findingId, 'approved');
    } finally { setBusy(''); }
  };
  return <div className="findings">
    <article className="nightly-summary">
      <div><h2>{props.data.lastNight.scheduled ? "Last night's run" : 'Latest refresh'}</h2>{props.data.lastNight.startedAt
        ? <p>{count(props.data.lastNight.connections)} {props.data.lastNight.connections === 1 ? 'source' : 'sources'} refreshed at {new Date(props.data.lastNight.startedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}: {count(props.data.lastNight.profiled)} changed objects profiled of {count(props.data.lastNight.listed)} listed.</p>
        : <p>No nightly refresh has run yet. Each source is refreshed once a day after it is added.</p>}</div>
      <Badge tone={alerts ? 'bad' : 'good'}>{alerts} open {alerts === 1 ? 'alert' : 'alerts'}</Badge>
      <div className="nightly-stats"><div><strong>{count(nightFindings.length)}</strong><span>findings in this refresh</span></div><div><strong>{count(alerts)}</strong><span>waiting for review</span></div><div><strong>{count(props.data.findings.filter((finding) => finding.status !== 'open').length)}</strong><span>reviewed</span></div></div>
      {props.refreshNow && <Button size="small" onClick={() => void props.refreshNow!()}>Run a refresh now</Button>}
    </article>
    <p>Approving a finding records your review and leaves its verification status unchanged.</p>
    <div className="findings-tabs" role="tablist" aria-label="Findings">{([['night', 'Latest refresh'], ['earlier', 'Earlier'], ['all', 'All']] as const).map(([key, label]) =>
      <Button key={key} role="tab" size="small" aria-selected={tab === key} className={`findings-tab${tab === key ? ' on' : ''}`} onClick={() => setTab(key)}>{label}</Button>)}</div>
    <div role="tablist" aria-label="Finding group">
      {(['Changes', 'Suggestions'] as const).map(name => <Button key={name} role="tab" aria-selected={name === group} onClick={() => setGroup(name)}>{name}</Button>)}
    </div>
    <Button size="small" disabled={Boolean(busy) || !pending.length} onClick={() => void approveGroup()}>Approve all {group.toLowerCase()}</Button>
    {shown.length ? <Table caption="Findings" headers={['Finding', 'Kind', 'When found', 'Affects', '']} rows={shown.map((finding) => [
      <span key="t">{findingText(finding)}</span>, <Badge key="k" tone={KIND[finding.kind]?.tone ?? 'muted'}>{KIND[finding.kind]?.label ?? finding.kind}</Badge>,
      new Date(finding.foundAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), findingSources(finding),
      finding.status === 'open' ? <span key="a" className="findings-actions"><Button size="small" variant="primary" disabled={Boolean(busy)} onClick={() => void act(finding.findingId, 'approved')}>{finding.kind === 'sensitive_column' ? 'Confirm' : 'Approve'}</Button><Button size="small" disabled={Boolean(busy)} onClick={() => void act(finding.findingId, 'rejected')}>{finding.kind === 'sensitive_column' ? 'Dismiss' : 'Reject'}</Button></span>
        : <Badge key="s" tone={finding.status === 'approved' ? 'good' : 'muted'}>{finding.status === 'approved' ? (finding.kind === 'sensitive_column' ? 'Confirmed' : 'Approved') : (finding.kind === 'sensitive_column' ? 'Dismissed' : 'Rejected')}</Badge>])} />
      : <EmptyState title={tab === 'night' ? 'Nothing found in this refresh' : 'No findings here'} description="Findings appear when a refresh finds a schema change, a large row-count change, a new table, a sensitive column, a probable relationship or an ID match." />}
  </div>;
}
