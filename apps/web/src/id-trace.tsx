import React, { useState } from 'react';
import { Badge, Button, EmptyState, Input, Table } from '@scaleinsyght/ui';

export type IdEntity = {
  entityId: string; label: string; home: string;
  fields: Array<{ assetId: string; field: string; sourceId: string; sourceName: string; connectorType: string; distinct: number; tagged: boolean; format: string;
    role: 'created' | 'kept' | 'key changed'; probable: boolean; sharedWithHome: number | null; evidence: Array<{ method: string; explanation: string | null; confidence: number | null }> }>;
};
const count = (value: number) => value.toLocaleString('en-US');
const roleText = { created: 'Comparison field', kept: 'Kept', 'key changed': 'Key changed' } as const;

function FieldName({ field }: { field: string }) {
  return <code className="id-field-name" title={field}>{field.split('.').map((part, index) =>
    <React.Fragment key={index}>{index > 0 && <>.<wbr /></>}{part}</React.Fragment>)}</code>;
}

/** ID trace (prototype "ID trace" tab): one value looked up live from keyed fingerprints, then each identifier's path. */
export function IdTrace(props: { entities: IdEntity[]; lookup: (value: string) => Promise<Array<{ assetId: string; field: string; sourceName: string }>> }) {
  const [selected, setSelected] = useState(props.entities[0]?.entityId ?? '');
  const [value, setValue] = useState('');
  const [found, setFound] = useState<Array<{ assetId: string; field: string; sourceName: string }> | null>(null);
  const [error, setError] = useState('');
  const entity = props.entities.find((item) => item.entityId === selected) ?? props.entities[0];
  async function trace(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try { setFound(await props.lookup(value)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'The lookup failed.'); setFound(null); }
    finally { setValue(''); }
  }
  const lookup = <article className="id-lookup"><div><h2>Look up one value</h2><p className="muted">Matched by its keyed fingerprint against each source's last profile. The value is never stored, logged or sent to the AI model.</p></div>
    <form className="id-lookup-form" onSubmit={(event) => void trace(event)}><Input aria-label="ID value" autoComplete="off" maxLength={256} value={value} onChange={(event) => setValue(event.target.value)} /><Button variant="primary" type="submit" disabled={!value.trim()}>Trace</Button></form>
    {error && <p className="error" role="alert">{error}</p>}
    {found && <div role="status">{found.length ? <><p>Found in {found.length} {found.length === 1 ? 'place' : 'places'}:</p><ul className="id-found">{found.map((item) => <li key={item.assetId}><FieldName field={item.field} /> <span className="muted">· {item.sourceName}</span></li>)}</ul></> : <p>That value is not in any profiled identifier field.</p>}</div>}
  </article>;
  if (!entity) return <div className="id-trace">{lookup}<EmptyState title="No identifier fields yet" description="Profile a source with columns tagged as identifiers. The ID agent fingerprints their values and matches them across sources." /></div>;
  const home = entity.fields.find((field) => field.role === 'created')!;
  const systems = new Set(entity.fields.map((field) => field.sourceId)).size;
  const lowest = entity.fields.filter((field) => field.role !== 'created' && field.sharedWithHome !== null && field.distinct > 0).map((field) => field.sharedWithHome! / field.distinct);
  const ordered = [home, ...entity.fields.filter((field) => field !== home && field.sourceId === home.sourceId), ...entity.fields.filter((field) => field.sourceId !== home.sourceId)];
  return <div className="id-trace">
    {lookup}
    <div className="id-picker" role="group" aria-label="Identifier">{props.entities.map((item) => <Button key={item.entityId} size="small" className={`id-chip${item.entityId === entity.entityId ? ' on' : ''}`} aria-pressed={item.entityId === entity.entityId} onClick={() => setSelected(item.entityId)}>{item.label}</Button>)}</div>
    <div className="lineage-tiles id-tiles"><div><b>{count(entity.fields.length)}</b><span>fields hold this ID</span></div><div><b>{count(systems)}</b><span>systems</span></div><div><b>{count(home.distinct)}</b><span>distinct values in comparison field</span></div><div><b>{lowest.length ? `${Math.round(Math.min(...lowest) * 100)}%` : '—'}</b><span>lowest share matching the comparison field</span></div></div>
    <article className="lineage-detail"><h2>Where {home.field.slice(home.field.lastIndexOf('.') + 1)} appears</h2>
      <p title="Matching values show that sources share an ID. They do not show where it was first created. The field with the largest measured set is used for comparison.">Origin unclear</p>
      <ol className="id-path">{ordered.map((field) => <li key={field.assetId}><div className="faint">{field.sourceName}</div><FieldName field={field.field} />
        <p className="muted">{field.role === 'created' ? 'Used for comparing shared values' : [...new Set(field.evidence.map((item) => item.explanation ?? item.method).filter(Boolean))].slice(0, 2).join('; ') || 'Matches the comparison field'}</p>
        <span className="id-badges"><Badge tone={field.role === 'key changed' ? 'warn' : field.role === 'created' ? 'primary' : 'good'}>{roleText[field.role]}</Badge>{field.probable && <Badge tone="warn">Probable, unverified</Badge>}</span></li>)}</ol></article>
    <article className="lineage-detail"><h2>Every place it appears</h2>
      <Table caption={`Every field holding ${entity.label}`} headers={['System', 'Field', 'What happens to the ID', 'Distinct values', 'Matching values']} rows={ordered.map((field) => [field.sourceName, <FieldName key="f" field={field.field} />,
        <span key="r">{roleText[field.role]}{field.probable ? ' · probable match, unverified' : ''}</span>, count(field.distinct),
        field.role === 'created' ? '—' : field.sharedWithHome === null ? 'Too many values to fingerprint' : `${count(field.sharedWithHome)} of ${count(field.distinct)} (${field.distinct ? Math.round((field.sharedWithHome / field.distinct) * 100) : 0}%)`])} />
      <p className="faint">Kept by the ID agent from keyed fingerprints. A match between systems is probable until someone approves it; approving never marks it verified.</p></article>
  </div>;
}
