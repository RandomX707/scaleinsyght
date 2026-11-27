/**
 * "Back to …" (CLAUDE.md 10.2): when a button jumps across pages, the page it came from is kept with the history entry
 * as { label, url }, and the shell shows a Back button naming the origin page and object. It survives reloads and the
 * browser's back and forward buttons; a sidebar click carries none, so the button goes away.
 */
export type Back = { label: string; url: string };
export type Navigate = (url: string, options?: { back?: Back }) => void;

/** The origin kept in a history entry's state, or null. Only same-app paths are accepted. */
export function readBack(state: unknown): Back | null {
  const back = (state as { back?: unknown } | null)?.back as { label?: unknown; url?: unknown } | undefined;
  if (!back || typeof back.label !== 'string' || typeof back.url !== 'string') return null;
  if (!back.label.trim() || back.label.length > 120 || !back.url.startsWith('/') || back.url.startsWith('//')) return null;
  return { label: back.label, url: back.url };
}

/** The current page's address, for the origin of a jump. */
export const here = () => location.pathname + location.search;
