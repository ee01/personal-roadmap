/**
 * Release Train Ruler — parse/fetch/geometry for Sprint-based gantt headers.
 * Apps Script token is hardcoded (read-only web app); team config lives in
 * roadmap-service `teams.release_sheet_json` and arrives via snapshot.
 */
import { addD, fmtISO, fmtMD, strip, today } from './useGeometry';

/** Same Apps Script deployment as RPA sheet reader; token is intentionally public. */
export const RELEASE_SHEET_APPS_SCRIPT = {
  baseUrl:
    'https://script.google.com/macros/s/AKfycbwuZvmS4tL8B0dUsAcBRsDpJNGQegx6JvSba7kfr_SEEJHEUPkUHJOFDghRF90GjS3I5A/exec',
  token: 'testTokenHere',
} as const;

export const RELEASE_SHEET_TTL_MS = 6 * 60 * 60 * 1000;

export type RulerMode = 'release' | 'month';
export type PhaseRulerKind = 'ff' | 're' | 'stage' | 'pro' | 'mr' | 'other';
export type ReleaseFilterMode = 'all' | 'major' | 'custom';

export interface ReleaseFilter {
  mode: ReleaseFilterMode;
  pattern: string;
}

export interface ReleaseSheetConfig {
  url: string;
  spreadsheetId: string;
  sheetName: string;
  range: string;
  splitPhase: string;
  showPhases: string[];
  /** Keep/drop rules for release names on the ruler (team-shared). */
  releaseFilter?: ReleaseFilter | null;
  rows: Array<Record<string, unknown>>;
  fetchedAt: string | null;
  /** Lazy full-parse cache (client-only, never persisted). */
  _parsedAll?: ParsedReleaseSchedule;
  /** Cache key for the last applied filter (`mode|pattern`). */
  _fkey?: string;
  /** Filtered parse result cache. */
  _fres?: ParsedReleaseSchedule;
}

export interface ReleaseFilterResult {
  parsed: ParsedReleaseSchedule;
  dropped: string[];
  invalid?: boolean;
  empty?: boolean;
}

export interface ReleasePhasePoint {
  release: string;
  phase: string;
  kind: PhaseRulerKind;
  date: Date;
}

export interface ReleaseBand {
  name: string;
  phases: ReleasePhasePoint[];
  start: Date;
  end: Date;
}

export interface ParsedReleaseSchedule {
  phases: ReleasePhasePoint[];
  releases: ReleaseBand[];
}

export interface ReleaseSegment {
  rel: ReleaseBand;
  start: Date;
  end: Date;
}

export interface PhaseOption {
  kind: PhaseRulerKind;
  raw: string;
  count: number;
}

export const PHASE_RULER: Record<
  PhaseRulerKind,
  { label: string; full: string; color: string }
> = {
  ff: { label: 'FF', full: 'Feature Freeze', color: '#B08BD9' },
  re: { label: 'Re', full: 'Regression', color: '#E0A458' },
  stage: { label: 'Stage', full: 'Stage', color: '#0684BC' },
  pro: { label: 'Pro', full: 'Production', color: '#2E8540' },
  mr: { label: 'MR', full: 'Multi-region', color: '#4FA3A5' },
  other: { label: '•', full: '自定义阶段', color: '#8B93A0' },
};

export const SPLIT_ORDER: PhaseRulerKind[] = [
  'ff',
  're',
  'stage',
  'pro',
  'mr',
  'other',
];

export function phaseKind(s: unknown): PhaseRulerKind {
  const v = String(s || '')
    .trim()
    .toLowerCase();
  if (v === 'ff' || v.includes('freeze')) return 'ff';
  if (v === 're' || v.startsWith('reg')) return 're';
  if (v.startsWith('stag')) return 'stage';
  if (v === 'pro' || v.startsWith('prod')) return 'pro';
  if (v.includes('multi')) return 'mr';
  return 'other';
}

export function extractSheetId(v: string): string {
  const m = (v || '').match(/\/d\/([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : (v || '').trim();
}

export function parseReleaseRows(
  rows: Array<Record<string, unknown>> | null | undefined,
): ParsedReleaseSchedule {
  const phases = (rows || [])
    .map((r) => ({
      release: String(r.Release ?? '').trim(),
      phase: String(r.Phase ?? '').trim(),
      kind: phaseKind(r.Phase),
      date: strip(new Date(String(r.Date ?? ''))),
    }))
    .filter((p) => p.release && !Number.isNaN(p.date.getTime()));

  const byRel = new Map<string, ReleasePhasePoint[]>();
  for (const p of phases) {
    if (!byRel.has(p.release)) byRel.set(p.release, []);
    byRel.get(p.release)!.push(p);
  }

  const releases = [...byRel.entries()]
    .map(([name, ph]) => {
      ph.sort((a, b) => a.date.getTime() - b.date.getTime());
      return {
        name,
        phases: ph,
        start: ph[0].date,
        end: ph[ph.length - 1].date,
      };
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  return { phases, releases };
}

/** Last numeric segment ends with 0 → major release (26.3.320 ✓, 26.3.325 ✕). */
export function isMajorRelease(name: string): boolean {
  const m = String(name).match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) % 10 === 0 : false;
}

/**
 * Wildcard / regex → keep predicate. `/…/` = regex; otherwise comma-separated
 * wildcards (`*` → `.*`), any match keeps. Invalid regex → null.
 */
export function releaseMatcher(
  pattern: string | null | undefined,
): ((s: string) => boolean) | null {
  const p = (pattern || '').trim();
  if (!p) return null;
  if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
    try {
      const re = new RegExp(p.slice(1, -1), 'i');
      return (s) => re.test(s);
    } catch {
      return null;
    }
  }
  const parts = p
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const res = parts.map(
    (w) =>
      new RegExp(
        `^${w.replace(/[.*+?^${}()|[\]\\]/g, (c) =>
          c === '*' ? '.*' : `\\${c}`,
        )}$`,
        'i',
      ),
  );
  return (s) => res.some((re) => re.test(s));
}

/** Normalize before persist: empty custom pattern → all. */
export function normFilter(
  f: ReleaseFilter | null | undefined,
): ReleaseFilter {
  const mode = (f?.mode || 'all') as ReleaseFilterMode;
  const pattern = (f?.pattern || '').trim();
  if (mode === 'custom' && !pattern) return { mode: 'all', pattern: '' };
  return {
    mode: mode === 'major' || mode === 'custom' ? mode : 'all',
    pattern: mode === 'custom' ? pattern : '',
  };
}

export function filterKey(f: ReleaseFilter | null | undefined): string {
  const n = normFilter(f);
  return `${n.mode}|${n.pattern}`;
}

/**
 * Apply keep-filter. On invalid regex / empty keep-set, returns original parsed
 * (never render an empty ruler).
 */
export function applyReleaseFilter(
  parsed: ParsedReleaseSchedule,
  filter: ReleaseFilter | null | undefined,
): ReleaseFilterResult {
  const f = normFilter(filter);
  if (!f.mode || f.mode === 'all') return { parsed, dropped: [] };
  let keep: (r: ReleaseBand) => boolean;
  if (f.mode === 'major') {
    keep = (r) => isMajorRelease(r.name);
  } else {
    const m = releaseMatcher(f.pattern);
    if (!m) return { parsed, dropped: [], invalid: !!f.pattern.trim() };
    keep = (r) => m(r.name);
  }
  const kept = parsed.releases.filter(keep);
  if (!kept.length) return { parsed, dropped: [], empty: true };
  const names = new Set(kept.map((r) => r.name));
  return {
    parsed: {
      releases: kept,
      phases: parsed.phases.filter((p) => names.has(p.release)),
    },
    dropped: parsed.releases
      .filter((r) => !names.has(r.name))
      .map((r) => r.name),
  };
}

/** Filtered schedule used by ruler / catch-sprint / split validation. */
export function relParsed(cfg: ReleaseSheetConfig): ParsedReleaseSchedule {
  if (!cfg._parsedAll) cfg._parsedAll = parseReleaseRows(cfg.rows);
  const key = filterKey(cfg.releaseFilter);
  if (cfg._fkey !== key) {
    cfg._fkey = key;
    cfg._fres = applyReleaseFilter(cfg._parsedAll, cfg.releaseFilter).parsed;
  }
  return cfg._fres!;
}

/** Full unfiltered parse (phase chips / sheet preview). */
export function relParsedAll(cfg: ReleaseSheetConfig): ParsedReleaseSchedule {
  if (!cfg._parsedAll) cfg._parsedAll = parseReleaseRows(cfg.rows);
  return cfg._parsedAll;
}

export function kindsInParsed(parsed: ParsedReleaseSchedule): PhaseRulerKind[] {
  const present = new Set(parsed.phases.map((p) => p.kind));
  return SPLIT_ORDER.filter((k) => present.has(k));
}

export function pickSplit(
  pref: string | null | undefined,
  parsed: ParsedReleaseSchedule,
): PhaseRulerKind {
  const ks = kindsInParsed(parsed);
  if (pref && ks.includes(pref as PhaseRulerKind)) return pref as PhaseRulerKind;
  return ks.includes('ff') ? 'ff' : ks[0] || 'ff';
}

export function normShow(
  sel: string[] | null | undefined,
  parsed: ParsedReleaseSchedule,
  split: PhaseRulerKind,
): PhaseRulerKind[] {
  const ks = kindsInParsed(parsed);
  let out: PhaseRulerKind[] =
    !sel || !sel.length
      ? ks
      : ks.filter((k) => sel.includes(k));
  if (!out.length) out = ks;
  if (split && !out.includes(split)) out = [split, ...out];
  return ks.filter((k) => out.includes(k));
}

export function shownKinds(
  cfg: Pick<ReleaseSheetConfig, 'showPhases' | 'splitPhase'>,
  parsed: ParsedReleaseSchedule,
): PhaseRulerKind[] {
  return normShow(cfg.showPhases, parsed, pickSplit(cfg.splitPhase, parsed));
}

export function phaseOptions(parsed: ParsedReleaseSchedule): PhaseOption[] {
  const m = new Map<
    PhaseRulerKind,
    { labels: Map<string, number>; count: number }
  >();
  for (const p of parsed.phases) {
    if (!m.has(p.kind)) m.set(p.kind, { labels: new Map(), count: 0 });
    const o = m.get(p.kind)!;
    o.count += 1;
    o.labels.set(p.phase, (o.labels.get(p.phase) || 0) + 1);
  }
  return SPLIT_ORDER.filter((k) => m.has(k)).map((k) => {
    const o = m.get(k)!;
    const raw = [...o.labels.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { kind: k, raw, count: o.count };
  });
}

/**
 * Sprint bands owned by the release that *ends* at the split phase.
 * Half-open `[prevSplit, thisSplit)`: the chosen phase is the handoff into
 * the next release (exclusive end). First band pads back to that release's
 * earliest phase, or 4d before the split when the split is the first phase.
 * Releases without the split phase never become their own column.
 */
export function relSegments(
  parsed: ParsedReleaseSchedule,
  splitKind: PhaseRulerKind,
): ReleaseSegment[] {
  const anchors: Array<{ rel: ReleaseBand; date: Date }> = [];
  for (const r of parsed.releases) {
    const sp = r.phases.find((p) => p.kind === splitKind);
    if (sp) anchors.push({ rel: r, date: sp.date });
  }
  anchors.sort((a, b) => a.date.getTime() - b.date.getTime());
  return anchors.map((a, i) => {
    let start: Date;
    if (i > 0) {
      start = anchors[i - 1].date;
    } else if (a.rel.start.getTime() < a.date.getTime()) {
      start = a.rel.start;
    } else {
      start = addD(a.date, -4);
    }
    return { rel: a.rel, start, end: a.date };
  });
}

function toLocalDay(end: Date | string): Date {
  if (end instanceof Date) return strip(end);
  const text = String(end).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return strip(new Date(text));
}

/**
 * Release column the date lands in on the Sprint ruler.
 * Half-open `[start, end)` so a date sitting on a split line belongs to the
 * next release (the vertical marker is the next column's left edge). The last
 * column is inclusive on the end so a Target End on the final split still
 * matches. This is what "Target End 落点" means — not `catchRelease`
 * (nearest Pro on/after, i.e. "可赶 Sprint").
 */
export function landRelease(
  end: Date | string,
  parsed: ParsedReleaseSchedule | null | undefined,
  splitKind?: PhaseRulerKind | string | null,
): ReleaseSegment | null {
  if (!parsed) return null;
  const endT = toLocalDay(end).getTime();
  const segs = relSegments(parsed, pickSplit(splitKind, parsed));
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const startT = strip(seg.start).getTime();
    const endBoundT = strip(seg.end).getTime();
    const last = i === segs.length - 1;
    if (endT >= startT && (last ? endT <= endBoundT : endT < endBoundT)) {
      return seg;
    }
  }
  return null;
}

export function landReleaseName(
  end: Date | string,
  cfg: ReleaseSheetConfig | null | undefined,
): string | null {
  if (!cfg?.rows?.length) return null;
  const parsed = relParsed(cfg);
  return landRelease(end, parsed, cfg.splitPhase)?.rel.name || null;
}

/** Nearest Pro on/after end date — "可赶 Sprint" hint. */
export function catchRelease(
  end: Date | string,
  parsed: ParsedReleaseSchedule | null | undefined,
): ReleasePhasePoint | null {
  if (!parsed) return null;
  const endD = typeof end === 'string' ? strip(new Date(end)) : strip(end);
  let best: ReleasePhasePoint | null = null;
  for (const p of parsed.phases) {
    if (
      p.kind === 'pro' &&
      p.date >= endD &&
      (!best || p.date < best.date)
    ) {
      best = p;
    }
  }
  return best;
}

export function catchReleaseHint(
  end: Date | string,
  parsed: ParsedReleaseSchedule | null | undefined,
): string {
  const cr = catchRelease(end, parsed);
  return cr
    ? ` · 赶 ${cr.release}（Pro ${fmtMD(cr.date)}）`
    : parsed
      ? ' · 已无可赶 Sprint'
      : '';
}

export function catchReleaseTooltipLine(
  end: Date | string,
  parsed: ParsedReleaseSchedule | null | undefined,
): string {
  const cr = catchRelease(end, parsed);
  if (!cr) return parsed ? '结束后已无可赶 Sprint' : '';
  return `结束后最近 Sprint ${cr.release}（Pro ${fmtMD(cr.date)}）`;
}

export function isReleaseSheetStale(cfg: ReleaseSheetConfig | null | undefined): boolean {
  if (!cfg?.fetchedAt) return true;
  const t = Date.parse(cfg.fetchedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > RELEASE_SHEET_TTL_MS;
}

export async function fetchReleaseSheetRows(input: {
  spreadsheetId: string;
  sheetName: string;
  range: string;
}): Promise<Array<Record<string, unknown>>> {
  const url =
    `${RELEASE_SHEET_APPS_SCRIPT.baseUrl}` +
    `?token=${encodeURIComponent(RELEASE_SHEET_APPS_SCRIPT.token)}` +
    `&spreadsheetId=${encodeURIComponent(input.spreadsheetId)}` +
    `&sheetName=${encodeURIComponent(input.sheetName)}` +
    `&range=${encodeURIComponent(input.range)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`release_sheet_fetch_failed:${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('release_sheet_invalid_payload');
  }
  return data as Array<Record<string, unknown>>;
}

export function buildReleaseSheetConfig(input: {
  url: string;
  sheetName?: string;
  range?: string;
  splitPhase?: string | null;
  showPhases?: string[] | null;
  releaseFilter?: ReleaseFilter | null;
  rows: Array<Record<string, unknown>>;
}): ReleaseSheetConfig | null {
  const url = input.url.trim();
  const spreadsheetId = extractSheetId(url);
  if (!url || !spreadsheetId) return null;
  const cfg: ReleaseSheetConfig = {
    url,
    spreadsheetId,
    sheetName: (input.sheetName || 'Sheet1').trim() || 'Sheet1',
    range: (input.range || 'A1:C500').trim() || 'A1:C500',
    splitPhase: 'ff',
    showPhases: [],
    releaseFilter: normFilter(input.releaseFilter),
    rows: input.rows,
    fetchedAt: new Date().toISOString(),
  };
  // Full parse must be non-empty; filtered may fall back to full via applyReleaseFilter.
  if (!relParsedAll(cfg).releases.length) return null;
  const parsed = relParsed(cfg);
  cfg.splitPhase = pickSplit(input.splitPhase, parsed);
  cfg.showPhases = normShow(
    input.showPhases,
    parsed,
    cfg.splitPhase as PhaseRulerKind,
  );
  return cfg;
}

export function formatCatchBarTip(
  end: Date | string,
  teamParsed: ParsedReleaseSchedule | null | undefined,
): string {
  const line = catchReleaseTooltipLine(end, teamParsed);
  return line ? `||${line}` : '';
}

export { fmtISO, today };
