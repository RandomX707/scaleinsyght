import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge, Button, Card, Collapsible, EmptyState, FileInput, Input, Logo, Modal, PageHeader, PoweredBy, Select, Table, Tabs, Textarea, Toast } from '../src/index.js';
import { prototypeTokens } from '../src/tokens.js';

describe('prototype-aligned shared UI', () => {
  it('ui_tokens_match_prototype_values', () => {
    expect(prototypeTokens).toMatchObject({
      bg: '#F8FAFC', surface: '#FFFFFF', side: '#F1F5F9', ink: '#0F172A', muted: '#475569', faint: '#64748B', line: '#E2E8F0',
      primary: '#5A67D8', primaryInk: '#4451C4', primaryTint: '#EEF0FC', profiler: '#0369A1', profilerTint: '#E0F2FE',
      analytic: '#C2410C', analyticTint: '#FFEDD5', good: '#15803D', goodTint: '#DCFCE7', warn: '#A16207', warnTint: '#FEF3C7', bad: '#B91C1C', badTint: '#FEE2E2',
      font: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', mono: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    });
    expect(prototypeTokens.typeScale).toEqual({ body: '14px', small: '12px', h1: '22px', h2: '16px', h3: '14px' });
    expect(prototypeTokens.spacing).toEqual(['2px', '4px', '6px', '8px', '10px', '12px', '14px', '16px', '18px', '20px', '22px', '24px']);
    expect(prototypeTokens.radii).toEqual(['8px', '9px', '10px', '12px', '14px', '16px', '999px']);
    expect(prototypeTokens.shadows).toEqual({ card: '0 1px 2px rgba(15,23,42,.06)', modal: '0 20px 50px rgba(15,23,42,.25)', toast: '0 10px 30px rgba(15,23,42,.3)' });
  });

  it('ui_shared_components_render_labeled_accessible_controls', () => {
    const markup = renderToStaticMarkup(<>
      <PageHeader title="Overview" description="Current state" />
      <Logo />
      <PoweredBy />
      <Card><Button variant="primary">Save</Button><Button variant="secondary">Cancel</Button><Button variant="ghost">More</Button></Card>
      <label>Email<Input aria-label="Email" /></label><label>Details<Textarea aria-label="Details" /></label><label>Source<Select aria-label="Source"><option>Riverside</option></Select></label><label>Dictionary file<FileInput label="Dictionary file" accept=".csv,.xlsx" onChange={() => undefined} /></label>
      <Tabs label="Sections" items={[{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }]} selected="one" onSelect={() => undefined} />
      <Badge tone="good">Ready</Badge><Table headers={['Name']} rows={[["Riverside"]]} />
      <EmptyState title="No reports" description="Reports explain decisions." action={<Button>Connect a source</Button>} />
      <Toast>Saved</Toast><Modal title="Confirm" open><p>Review this change.</p></Modal><Collapsible title="More details"><p>Details</p></Collapsible>
    </>);
    expect(markup).toContain('aria-label="Sections"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('alt="INSYGHT"');
    expect(markup).toContain('alt="ScaleHealthTech"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('<details class="ui-collapsible">');
    expect(markup).toContain('class="ui-button ui-button--primary"');
    expect(markup).toContain('Email');
    expect(markup).toContain('Details');
    expect(markup).toContain('Source');
    expect(markup).toContain('ui-file-input__native');
    expect(markup).toContain('Choose file');
    expect(markup).toContain('ui-file-input__native');
    expect(markup).toContain('Choose file');
  });
});
