import { ref } from 'vue';

export const MS = 86_400_000;

/**
 * Gantt zoom: pixels per day. A ref (not a plain constant) so GanttPanel's
 * wheel/pinch handler can rescale the whole timeline live; every geometry
 * helper below reads `DAY_W.value`, and any `.vue` file that imports `DAY_W`
 * by name gets it auto-unwrapped in its own template.
 */
export const DAY_W_DEFAULT = 7;
export const DAY_W_MIN = 2.2;
export const DAY_W_MAX = 24;
export const DAY_W = ref(DAY_W_DEFAULT);

export const strip = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const today = strip(new Date());

export const addD = (d: Date | string, n: number) => {
  const base = typeof d === 'string' ? parseDate(d) : d;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
};

export const diffD = (a: Date | string, b: Date | string) =>
  Math.round((strip(typeof b === 'string' ? parseDate(b) : b).getTime() -
    strip(typeof a === 'string' ? parseDate(a) : a).getTime()) / MS);

export const fmtMD = (d: Date | string) => {
  const dt = typeof d === 'string' ? parseDate(d) : d;
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

export const fmtYM = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export const fmtISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const clamp = (v: number, a: number, b: number) =>
  Math.max(a, Math.min(b, v));

export const parseDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const qOf = (d: Date) =>
  `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;

export const qStart = (q: string) => {
  const [y, n] = q.split('-Q');
  return new Date(+y, (+n - 1) * 3, 1);
};

export const qEnd = (q: string) => {
  const [y, n] = q.split('-Q');
  return new Date(+y, +n * 3, 0);
};

export const nextQ = (q: string) => {
  const [y, n] = q.split('-Q').map(Number);
  return n === 4 ? `${y + 1}-Q1` : `${y}-Q${n + 1}`;
};

export const prevQ = (q: string) => {
  const [y, n] = q.split('-Q').map(Number);
  return n === 1 ? `${y - 1}-Q4` : `${y}-Q${n - 1}`;
};

export const qCmp = (a: string, b: string) => qStart(a).getTime() - qStart(b).getTime();

export const CURQ = qOf(today);

export const qByOffset = (n: number) => {
  let q = CURQ;
  for (let i = 0; i < n; i++) q = nextQ(q);
  return q;
};

export const mStart = new Date(today.getFullYear(), today.getMonth(), 1);
export const mEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

export interface TimelineMonth {
  y: number;
  m: number;
  days: number;
  cur: boolean;
}

export interface Timeline {
  start: Date;
  end: Date;
  days: number;
  months: TimelineMonth[];
}

export function computeTL(checkedQuarters: string[]): Timeline {
  const list = chipList(checkedQuarters);
  const s0 = qStart(CURQ);
  const start = new Date(s0.getFullYear(), s0.getMonth() - 1, 1);
  const end = qEnd(list[list.length - 1]);
  const months: TimelineMonth[] = [];
  let m = new Date(start);
  while (m <= end) {
    const dim = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    months.push({
      y: m.getFullYear(),
      m: m.getMonth(),
      days: dim,
      cur:
        m.getFullYear() === today.getFullYear() &&
        m.getMonth() === today.getMonth(),
    });
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }
  return { start, end, days: diffD(start, end) + 1, months };
}

export function chipList(checked: string[]): string[] {
  let latest = checked.length
    ? checked.reduce((a, b) => (qCmp(a, b) > 0 ? a : b))
    : CURQ;
  if (qCmp(latest, CURQ) < 0) latest = CURQ;
  const end = nextQ(latest);
  const list: string[] = [];
  let q = CURQ;
  while (true) {
    list.push(q);
    if (q === end) break;
    q = nextQ(q);
  }
  return list;
}

export function dateMs(d: Date | string): number {
  return strip(typeof d === 'string' ? parseDate(d) : d).getTime();
}

/** Inclusive overlap: start..end intersects winS..winE. Accepts ISO strings or Date. */
export function rangesOverlap(
  start: Date | string,
  end: Date | string,
  winS: Date | string,
  winE: Date | string,
): boolean {
  return dateMs(end) >= dateMs(winS) && dateMs(start) <= dateMs(winE);
}

/** Pixel offset of a calendar day from the timeline start (left edge of the day cell). */
export function X(tl: Timeline, d: Date | string): number {
  return diffD(tl.start, d) * DAY_W.value;
}

export const dateAtX = (tl: Timeline, px: number) =>
  addD(tl.start, Math.round(px / DAY_W.value));

export function colorCls(start: Date | string, days: number): string {
  const s = typeof start === 'string' ? parseDate(start) : start;
  const end = addD(s, days - 1);
  if (end < mStart) return 'c-past';
  if (s > mEnd) return 'c-fut';
  return 'c-cur';
}

/** True when the team JQL declares a Target Delivery Quarter filter. */
export function jqlHasTargetDeliveryQuarter(jql: string): boolean {
  return /"Target Delivery Quarter"\s+in\s*\(/i.test(jql || '');
}

export function effectiveJqlHtml(jql: string, quarters: string[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (!quarters.length || !jqlHasTargetDeliveryQuarter(jql)) {
    return esc(jql || '');
  }
  const re = /("Target Delivery Quarter"\s+in\s*\()([^)]*)(\))/gi;
  const out = jql.replace(re, (_, p1: string, _2: string, p3: string) => {
    return `${p1}@@${p3}`;
  });
  return esc(out).replace(/@@/g, `<mark>${quarters.join(', ')}</mark>`);
}

export function fitLanes(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.g-lane').forEach((lane) => {
    const bar = lane.querySelector(':scope > .bar') as HTMLElement | null;
    if (!bar) return;
    const track = lane.querySelector(':scope > .marker-track') as HTMLElement | null;
    const barBottom = 9 + bar.offsetHeight;
    let h = Math.max(58, barBottom + 18);
    if (track) {
      h = Math.max(h, barBottom + 30);
      track.style.top = `${barBottom}px`;
    }
    lane.style.height = `${h}px`;
  });
  root.querySelectorAll<HTMLElement>('.sbar.free-h').forEach((b) => {
    const parent = b.parentElement;
    if (parent) parent.style.height = `${b.offsetHeight + 14}px`;
  });
}

export const AV_COLORS = [
  '#5B8DEF',
  '#E4708A',
  '#57A773',
  '#B08BD9',
  '#E0A458',
  '#4FA3A5',
  '#C97B5A',
];

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * Copy text in both secure (HTTPS / localhost) and plain HTTP contexts.
 * `navigator.clipboard` is often unavailable on http://host:port; fall back
 * to a hidden textarea + execCommand('copy').
 */
export async function copyTextToClipboard(
  text: string,
): Promise<'clipboard' | 'exec' | false> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard?.writeText &&
    typeof window !== 'undefined' &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return 'clipboard';
    } catch {
      // fall through to execCommand
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return 'exec';
  } catch {
    // fall through
  }
  return false;
}
