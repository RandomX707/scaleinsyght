import React, { type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import './components.css';
import logoUrl from './assets/insyght-logo.png';
import poweredByUrl from './assets/scalehealthtech-logo.png';

export { prototypeTokens } from './tokens.js';
export { answerTitle, listNames, plural, runProgressLabel, runStatusLabel } from './run-status.js';

export function Logo({ className = '' }: { className?: string }) { return <img className={`ui-logo ${className}`.trim()} src={logoUrl} alt="INSYGHT" />; }
export function PoweredBy() { return <div className="ui-powered-by"><span>Powered by</span><img src={poweredByUrl} alt="ScaleHealthTech" /></div>; }

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <header className="ui-page-header"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div>{actions}</div>}</header>;
}

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) { return <section className={`ui-card ${className}`.trim()} {...props} />; }

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost'; size?: 'default' | 'small' };
export function Button({ variant = 'secondary', size = 'default', className = '', ...props }: ButtonProps) { return <button className={`ui-button ui-button--${variant}${size === 'small' ? ' ui-button--small' : ''} ${className}`.trim()} {...props} />; }

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) { return <input className={`ui-input ${className}`.trim()} {...props} />; }
export function FileInput({ label, accept, onChange }: { label: string; accept?: string; onChange: (event: React.ChangeEvent<HTMLInputElement>) => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  const [filename, setFilename] = React.useState('No file selected');
  return <div className="ui-file-input"><input ref={ref} className="ui-file-input__native" type="file" aria-label={label} accept={accept} onChange={event => { setFilename(event.currentTarget.files?.[0]?.name ?? 'No file selected'); onChange(event); }} /><Button type="button" onClick={() => ref.current?.click()}>Choose file</Button><span aria-live="polite">{filename}</span></div>;
}
export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className={`ui-textarea ${className}`.trim()} {...props} />; }
export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) { return <select className={`ui-select ${className}`.trim()} {...props} />; }

export function Tabs({ label, items, selected, onSelect }: { label: string; items: Array<{ id: string; label: string }>; selected: string; onSelect: (id: string) => void }) {
  return <div className="ui-tabs" role="tablist" aria-label={label}>{items.map(item => <button className="ui-tab" type="button" role="tab" key={item.id} aria-selected={selected === item.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}</div>;
}

/** Two or more mutually exclusive options in a pill-shaped track (prototype .seg). */
export function SegmentedControl({ label, items, selected, onSelect }: { label: string; items: Array<{ id: string; label: ReactNode }>; selected: string; onSelect: (id: string) => void }) {
  return <div className="ui-segmented" role="tablist" aria-label={label}>{items.map(item => <button className="ui-segmented__item" type="button" role="tab" key={item.id} aria-selected={selected === item.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}</div>;
}

/** Open documents as pill tabs, each closable except the fixed ones (prototype .dtab). */
export function PillTabs({ label, items, selected, onSelect, onClose }: { label: string; items: Array<{ id: string; label: string; closable?: boolean }>; selected: string; onSelect: (id: string) => void; onClose?: (id: string) => void }) {
  return <div className="ui-pill-tabs" role="tablist" aria-label={label}>{items.map(item => <span key={item.id} className={`ui-pill-tab${selected === item.id ? ' is-selected' : ''}`}>
    <button type="button" role="tab" aria-selected={selected === item.id} onClick={() => onSelect(item.id)}>{item.label}</button>
    {item.closable && onClose && <button type="button" className="ui-pill-tab__close" aria-label={`Close ${item.label}`} onClick={() => onClose(item.id)}>×</button>}
  </span>)}</div>;
}

/** A small set of mutually exclusive choices shown side by side, each with its own tone when chosen (prototype .scseg). */
export function ChoiceSegments<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ id: T; label: string; tone: 'good' | 'primary' | 'bad'; title?: string }>; value: T; onChange: (id: T) => void }) {
  return <div className="ui-choice-segments" role="radiogroup" aria-label={label}>{options.map(option => <button key={option.id} type="button" role="radio" aria-checked={value === option.id}
    className={value === option.id ? `is-on ui-choice-segments--${option.tone}` : ''} title={option.title} onClick={() => onChange(option.id)}>{option.label}</button>)}</div>;
}

export function Badge({ tone = 'primary', children }: { tone?: 'primary' | 'good' | 'warn' | 'bad' | 'muted'; children: ReactNode }) { return <span className={`ui-badge${tone === 'primary' ? '' : ` ui-badge--${tone}`}`}>{children}</span>; }

export function Table({ headers, rows, caption }: { headers: ReactNode[]; rows: ReactNode[][]; caption?: string }) {
  return <div className="ui-table-wrap"><table className="ui-table">{caption && <caption>{caption}</caption>}<thead><tr>{headers.map((header, index) => <th key={index} scope="col">{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <section className="ui-empty-state"><h2>{title}</h2><p>{description}</p>{action && <div>{action}</div>}</section>; }
export function Toast({ children, tone = 'status' }: { children: ReactNode; tone?: 'status' | 'alert' }) { return <div className="ui-toast" role={tone}>{children}</div>; }
export function Modal({ title, open, onClose, children }: { title: string; open: boolean; onClose?: () => void; children: ReactNode }) {
  if (!open) return null;
  return <div className="ui-modal-scrim"><section className="ui-modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2>{onClose && <Button aria-label="Close dialog" variant="ghost" onClick={onClose}>×</Button>}</header>{children}</section></div>;
}
export function Collapsible({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) { return <details className="ui-collapsible" open={defaultOpen}><summary>{title}</summary><div className="ui-collapsible-content">{children}</div></details>; }
