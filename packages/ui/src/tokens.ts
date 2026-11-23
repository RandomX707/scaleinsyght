export const prototypeTokens = {
  bg: '#F8FAFC', surface: '#FFFFFF', side: '#F1F5F9', ink: '#0F172A', muted: '#475569', faint: '#64748B', line: '#E2E8F0',
  primary: '#5A67D8', primaryInk: '#4451C4', primaryTint: '#EEF0FC', profiler: '#0369A1', profilerTint: '#E0F2FE',
  analytic: '#C2410C', analyticTint: '#FFEDD5', good: '#15803D', goodTint: '#DCFCE7', warn: '#A16207', warnTint: '#FEF3C7', bad: '#B91C1C', badTint: '#FEE2E2',
  font: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', mono: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  typeScale: { body: '14px', small: '12px', h1: '22px', h2: '16px', h3: '14px' },
  spacing: ['2px', '4px', '6px', '8px', '10px', '12px', '14px', '16px', '18px', '20px', '22px', '24px'],
  radii: ['8px', '9px', '10px', '12px', '14px', '16px', '999px'],
  shadows: { card: '0 1px 2px rgba(15,23,42,.06)', modal: '0 20px 50px rgba(15,23,42,.25)', toast: '0 10px 30px rgba(15,23,42,.3)' },
} as const;
