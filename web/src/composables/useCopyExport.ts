import { computed, reactive } from 'vue';
import { addD, dateMs, esc, fmtISO, fmtMD, today } from './useGeometry';
import {
  isDraftItem,
  itemDisplayKey,
  jiraBrowseUrl,
} from './useRoadmapContract';
import {
  dependencyGroups,
  dependencyTiming,
  type DependencyFilter,
} from './dependency';
import { dispName, teamAssigneeMap } from './useAssigneeMap';
import { useRoadmapState } from './useRoadmapState';
import type { RoadmapItem, RoadmapSub, TeamMember } from '../types';

/**
 * 复制导出（过滤行最右，交互设计见 docs/demo/roadmap-demo.html 同名区块）。
 *
 * 复制范围 = 当前视图看到的东西：任务视图 → 甘特上的 Epic；人员视图 → 按人
 * 分组的 Task（近 2 周模式默认只复制时间窗内的任务）。Milestone 过滤 / 搜索
 * 开启时，两种视图都只复制过滤后的结果（口径与 viewMatch 一致：搜索命中
 * Epic 本身或其子任务），并在回执卡里写明过滤条件。
 *
 * 剪贴板一次写两种格式：text/html（表格 = <table>，Key 为超链接；列表 = <ul>）
 * 与 text/plain（表格 = Key⇥Summary 的 TSV；列表 = 每行一条）。表格粘到
 * Google Sheet 自动分列且 Key 可点；列表粘到文档 / 聊天直接可读。
 *
 * 「粘贴到」默认选中「列表 · 文档 / 聊天」——一键复制出来的就是可直接贴进
 * 聊天的列表；需要 Sheet 分列时再切到表格。选项按视图记忆（localStorage，
 * 无需同步到团队）。主按钮一键复制即完成；随后的回执卡上勾选附加列会立即
 * 重写剪贴板，没有第二步「再复制」。
 */

export type CopyView = 'gantt' | 'resource' | 'dependency';
export type CopyFormat = 'table' | 'list';

/** 两种视图共用一张选项表；各字段只在所属视图里生效。 */
export interface CopyOptions {
  /** 甘特：附带子任务行（缩进在 Epic 下） */
  subs: boolean;
  /** 甘特：Assignee 列（取子任务 Owner 的并集） */
  asg: boolean;
  /** 人员：按人 = 分组标题行 或 Assignee 列 */
  asgMode: 'group' | 'col';
  /** 人员：所属 Epic 列 */
  epic: boolean;
  status: boolean;
  /** 排期 = Start / End 两列（ISO 格式，Sheet 可识别为日期） */
  dates: boolean;
  /** 表格：首行表头 */
  header: boolean;
  /** 粘贴到：表格（Sheet 分列）或列表（文档 / 聊天）。默认列表。 */
  fmt: CopyFormat;
  /** 人员：近 2 周模式下只复制时间窗内的任务 */
  winOnly: boolean;
}

export const COPY_OPTIONS_KEY = 'personalroadmap.copyOpts';

export const COPY_DEFAULTS: Record<CopyView, CopyOptions> = {
  dependency: {
    subs: false,
    asg: false,
    asgMode: 'col',
    epic: true,
    status: true,
    dates: true,
    header: true,
    fmt: 'list',
    winOnly: false,
  },
  gantt: {
    subs: false,
    asg: false,
    asgMode: 'col',
    epic: false,
    status: false,
    dates: false,
    header: false,
    fmt: 'list',
    winOnly: true,
  },
  resource: {
    subs: false,
    asg: false,
    asgMode: 'group',
    epic: false,
    status: false,
    dates: false,
    header: false,
    fmt: 'list',
    winOnly: true,
  },
};

function readSavedCopyOptions(): Record<string, Partial<CopyOptions>> {
  try {
    const raw =
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(COPY_OPTIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // private mode / corrupted value
  }
}

export function loadCopyOptions(): Record<CopyView, CopyOptions> {
  const saved = readSavedCopyOptions();
  const merge = (view: CopyView): CopyOptions => ({
    ...COPY_DEFAULTS[view],
    ...(saved[view] || {}),
  });
  return {
    gantt: merge('gantt'),
    resource: merge('resource'),
    dependency: merge('dependency'),
  };
}

export function saveCopyOptions(options: Record<CopyView, CopyOptions>) {
  try {
    localStorage.setItem(COPY_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    /* private mode */
  }
}

/* ---------- 收集：视图数据 → 行 ---------- */

export interface CopyRow {
  lvl: 0 | 1;
  /** Jira key；草稿（尚未创建）为 null，输出时标 DRAFT、不带链接 */
  key: string | null;
  summary: string;
  asg: string;
  epic: string;
  status: string;
  start: string | null;
  end: string | null;
  need?: string;
  eta?: string;
  risk?: string;
  targetStart?: string;
  targetEnd?: string;
}

export interface CopyGroup {
  /** 人员视图 = 成员名；甘特 = null（不分 group） */
  name: string | null;
  rows: CopyRow[];
}

export type CopyNoteAct = { kind: 'winOnly'; value: boolean };

export interface CopyNote {
  cls: 'ms' | 'win' | 'warn';
  html: string;
  act?: CopyNoteAct;
}

export interface CopyData {
  groups: CopyGroup[];
  notes: CopyNote[];
  /** 主行数（甘特 = Epic 数；人员 = Task 数） */
  n: number;
  unit: 'Epic' | 'Task' | '依赖';
  /** 甘特：过滤口径下的子任务总数（勾「子任务」后全部进入复制） */
  subN: number;
  /** 人员：有任务的人数（含未分配组） */
  people: number;
  /** Milestone / 搜索过滤是否生效（空态提示用） */
  filtered: boolean;
}

export interface CopyCollectInput {
  view: CopyView;
  dependencyFilter?: DependencyFilter;
  /** 已排期条目，按甘特 lane 顺序 */
  items: RoadmapItem[];
  members: TeamMember[];
  /** 甘特：是否带子任务行 */
  includeSubs: boolean;
  search: string;
  /** 选中的 milestone 名称（用于过滤说明）；null = 未开启 milestone 过滤 */
  msNames: string | null;
  /** 人员视图的时间窗（winOnly 生效时传入）；null = 不限 */
  win: { s: Date; e: Date } | null;
  /** 人员视图是否为「全部时间」模式 */
  resWinAll: boolean;
  /** 与甘特行过滤同口径：milestone（OR）AND 文本（含子任务命中） */
  epicMatch: (it: RoadmapItem) => boolean;
  /** 系统名 → 显示名（Assignee 映射） */
  showName: (raw: string | null | undefined) => string;
}

/** 单元格值清洗：Tab / 换行一律压成空格，保证 TSV 不串列。 */
export const cpCell = (s: unknown) =>
  String(s ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
export const cpEscA = (s: string) => esc(s).replace(/"/g, '&quot;');

function searchTokens(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Epic 自身字段命中搜索（与 state.textMatch 同字段，但不含子任务）。 */
function epicSelfMatch(it: RoadmapItem, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const hay = [
    it.title,
    it.key,
    it.jiraKey || '',
    it.alias || '',
    it.type || '',
    it.quarter || '',
    it.parentLink || '',
    it.owner || '',
    itemDisplayKey(it),
  ]
    .join(' ')
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function subMatch(s: RoadmapSub, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const hay = [s.title, s.key || '', s.alias || '', s.owner || '']
    .join(' ')
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function statusOf(row: { status?: string | null }, draft: boolean): string {
  return row.status || (draft ? 'Draft' : '');
}

function endOf(
  start: string | null | undefined,
  days: number | null | undefined,
): string | null {
  if (!start || !days) return null;
  return fmtISO(addD(start, days - 1));
}

function filterNote(
  n: number,
  total: number,
  unit: string,
  msNames: string | null,
  search: string,
): CopyNote | null {
  const parts: string[] = [];
  if (msNames) parts.push(`Milestone「<b>${esc(msNames)}</b>」`);
  const q = search.trim();
  if (q) parts.push(`搜索「<b>${esc(q)}</b>」`);
  if (!parts.length) return null;
  return {
    cls: 'ms',
    html: `已按筛选复制：${parts.join(' + ')} · ${n} / ${total} 个 ${unit}`,
  };
}

function draftNote(drafts: number): CopyNote | null {
  return drafts
    ? {
        cls: 'warn',
        html: `${drafts} 条为草稿，尚未创建到 Jira —— Key 列标为 DRAFT、无链接`,
      }
    : null;
}

export function collectCopyData(input: CopyCollectInput): CopyData {
  const { items, epicMatch, showName } = input;
  const tokens = searchTokens(input.search);
  /** Epic 自身命中搜索 → 带全部子任务；仅子任务命中 → 只带命中的子任务 */
  const subsOf = (it: RoadmapItem): RoadmapSub[] => {
    const subs = it.subs.filter((s) => !s.cleared);
    if (!tokens.length || epicSelfMatch(it, tokens)) return subs;
    return subs.filter((s) => subMatch(s, tokens));
  };
  const filtered = Boolean(input.msNames) || Boolean(input.search.trim());

  if (input.view === 'dependency') {
    const groups = dependencyGroups(
      items.filter(epicMatch),
      input.dependencyFilter,
    );
    const rows: CopyRow[] = groups.flatMap(({ item, deps }) =>
      deps.map((dep) => ({
        lvl: 0 as const,
        key: dep.jiraKey || null,
        summary: dep.label,
        asg: '',
        epic: `${itemDisplayKey(item)} ${item.alias || item.title}`,
        status: dep.jiraStatus || '',
        start: null,
        end: null,
        need: dep.need || dep.date || '未设置',
        eta: dep.date || '未确认',
        risk: dependencyTiming(dep),
        targetStart: dep.jiraTargetStart || '',
        targetEnd: dep.jiraTargetEnd || '',
      })),
    );
    const notes: CopyNote[] = [];
    const note = filterNote(
      groups.length,
      items.length,
      'Epic',
      input.msNames,
      input.search,
    );
    if (note) notes.push(note);
    if (input.dependencyFilter && input.dependencyFilter !== 'all')
      notes.push({ cls: 'warn', html: '仅复制依赖视图当前风险筛选下的依赖' });
    return {
      groups: [{ name: null, rows }],
      notes,
      n: rows.length,
      unit: '依赖',
      subN: 0,
      people: 0,
      filtered:
        filtered ||
        (input.dependencyFilter !== undefined &&
          input.dependencyFilter !== 'all'),
    };
  }

  if (input.view === 'gantt') {
    const epics = items.filter(epicMatch);
    const rows: CopyRow[] = [];
    const notes: CopyNote[] = [];
    let subN = 0;
    let drafts = 0;
    for (const it of epics) {
      const subs = subsOf(it).sort(
        (a, b) => dateMs(a.start || '') - dateMs(b.start || ''),
      );
      const owners = [
        ...new Set(subs.filter((s) => s.owner).map((s) => showName(s.owner))),
      ];
      const draft = isDraftItem(it);
      if (draft) drafts += 1;
      rows.push({
        lvl: 0,
        key: draft ? null : itemDisplayKey(it),
        summary: it.title,
        asg: owners.join(', '),
        epic: it.alias || it.title,
        status: statusOf(it, draft),
        start: it.start || null,
        end: endOf(it.start, it.days),
      });
      subN += subs.length;
      if (input.includeSubs) {
        for (const s of subs) {
          if (!s.key) drafts += 1;
          rows.push({
            lvl: 1,
            key: s.key || null,
            summary: s.title,
            asg: s.owner ? showName(s.owner) : '',
            epic: it.alias || it.title,
            status: statusOf(s, s.temp && !s.key),
            start: s.start || null,
            end: endOf(s.start, s.days),
          });
        }
      }
    }
    const note = filterNote(
      epics.length,
      items.length,
      'Epic',
      input.msNames,
      input.search,
    );
    if (note) notes.push(note);
    const draft = draftNote(drafts);
    if (draft) notes.push(draft);
    return {
      groups: [{ name: null, rows }],
      notes,
      n: epics.length,
      unit: 'Epic',
      subN,
      people: 0,
      filtered,
    };
  }

  /* 人员视图：与 renderResource 同口径（甘特上未清理的子任务，含草稿；成员 + 未分配） */
  const people = [
    ...input.members.map((m) => ({ raw: m.name, name: showName(m.name) })),
    { raw: null, name: '未分配' },
  ];
  let drafts = 0;
  let total = 0;
  const groups: CopyGroup[] = [];
  for (const p of people) {
    const rows: CopyRow[] = [];
    for (const it of items) {
      const matched = epicMatch(it) ? subsOf(it) : [];
      for (const s of it.subs) {
        if (s.cleared || (s.owner || null) !== p.raw) continue;
        const end = endOf(s.start, s.days);
        if (input.win) {
          if (!s.start || !end) continue; // 时间窗内无法判定 → 与人员视图一致不展示
          if (
            dateMs(end) < dateMs(input.win.s) ||
            dateMs(s.start) > dateMs(input.win.e)
          ) {
            continue;
          }
        }
        total += 1;
        if (!matched.includes(s)) continue;
        if (!s.key) drafts += 1;
        rows.push({
          lvl: 0,
          key: s.key || null,
          summary: s.title,
          asg: p.name,
          epic: it.alias || it.title,
          status: statusOf(s, s.temp && !s.key),
          start: s.start || null,
          end,
        });
      }
    }
    rows.sort((a, b) => dateMs(a.start || '') - dateMs(b.start || ''));
    if (rows.length) groups.push({ name: p.name, rows });
  }
  const n = groups.reduce((a, g) => a + g.rows.length, 0);
  const notes: CopyNote[] = [];
  const note = filterNote(n, total, 'Task', input.msNames, input.search);
  if (note) notes.push(note);
  if (!input.resWinAll) {
    notes.push(
      input.win
        ? {
            cls: 'win',
            html: `仅时间窗内：<b>${fmtMD(input.win.s)} → ${fmtMD(input.win.e)}</b>`,
            act: { kind: 'winOnly', value: false },
          }
        : {
            cls: 'win',
            html: '包含全部时间（不限当前 14 天窗口）',
            act: { kind: 'winOnly', value: true },
          },
    );
  }
  const draft = draftNote(drafts);
  if (draft) notes.push(draft);
  return {
    groups,
    notes,
    n,
    unit: 'Task',
    subN: 0,
    people: groups.length,
    filtered,
  };
}

/* ---------- 序列化：行 → 剪贴板内容 ---------- */

export interface CopyPayload {
  html: string;
  text: string;
  lines: number;
}

/** 列定义：Key、Summary 固定在 A / B 列，附加信息依次往后。 */
export function copyColumns(
  view: CopyView,
  opts: CopyOptions,
): Array<[string, string]> {
  if (view === 'dependency')
    return [
      ['key', 'Ticket'],
      ['summary', '依赖内容'],
      ['epic', '所属任务'],
      ['need', '期望日期'],
      ['eta', 'ETA'],
      ['risk', '风险 / 余量'],
      ['status', 'Jira 状态'],
      ['targetStart', 'Target Start'],
      ['targetEnd', 'Target End'],
    ];
  const cols: Array<[string, string]> = [
    ['key', 'Key'],
    ['summary', 'Summary'],
  ];
  if (view === 'gantt' ? opts.asg : opts.asgMode === 'col') {
    cols.push(['asg', 'Assignee']);
  }
  if (view === 'resource' && opts.epic) cols.push(['epic', 'Epic']);
  if (opts.status) cols.push(['status', 'Status']);
  if (opts.dates) cols.push(['start', 'Start'], ['end', 'End']);
  return cols;
}

export function cellVal(r: CopyRow, k: string): string {
  if (['need', 'eta', 'risk', 'targetStart', 'targetEnd'].includes(k))
    return String(r[k as keyof CopyRow] || '');
  if (k === 'summary') return (r.lvl ? '↳ ' : '') + r.summary;
  if (k === 'start' || k === 'end') return r[k] || '';
  if (k === 'asg') return r.asg;
  if (k === 'epic') return r.epic;
  if (k === 'status') return r.status;
  return '';
}

/** 嵌套列表：子任务行收进父条目的 <ul> 里（对应纯文本的 4 空格缩进）。 */
function listHtml(rows: CopyRow[], li: (r: CopyRow) => string): string {
  const out: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    const children: CopyRow[] = [];
    let j = i + 1;
    if (r.lvl === 0) {
      while (j < rows.length && rows[j].lvl === 1) {
        children.push(rows[j]);
        j += 1;
      }
    }
    let html = `<li>${li(r)}`;
    if (children.length) {
      html += `<ul>${children.map((c) => `<li>${li(c)}</li>`).join('')}</ul>`;
    }
    out.push(`${html}</li>`);
    i = j;
  }
  return `<ul>${out.join('')}</ul>`;
}

export function buildCopyPayload(
  data: CopyData,
  opts: CopyOptions,
  view: CopyView,
  jiraBrowseBase: string,
): CopyPayload {
  const cols = copyColumns(view, opts);
  const grouped = view === 'resource' && opts.asgMode === 'group';
  const link = (k: string | null) =>
    k
      ? `<a href="${cpEscA(jiraBrowseUrl(k, jiraBrowseBase))}">${esc(k)}</a>`
      : view === 'dependency'
        ? '手动依赖'
        : 'DRAFT';

  let html = '';
  let text = '';

  if (opts.fmt === 'table') {
    const tr = (cells: string[]) => `<tr>${cells.join('')}</tr>`;
    if (opts.header) {
      html += tr(cols.map(([, h]) => `<th style="text-align:left">${h}</th>`));
      text += `${cols.map(([, h]) => h).join('\t')}\n`;
    }
    for (const g of data.groups) {
      if (grouped) {
        html += tr([
          `<td colspan="${cols.length}"><b>${esc(g.name || '')}</b> (${g.rows.length})</td>`,
        ]);
        text += `${cpCell(g.name)} (${g.rows.length})\n`;
      }
      for (const r of g.rows) {
        html += tr(
          cols.map(
            ([k]) =>
              `<td>${k === 'key' ? link(r.key) : esc(cpCell(cellVal(r, k)))}</td>`,
          ),
        );
        text += `${cols
          .map(([k]) =>
            k === 'key'
              ? r.key || (view === 'dependency' ? '手动依赖' : 'DRAFT')
              : cpCell(cellVal(r, k)),
          )
          .join('\t')}\n`;
      }
    }
    html = `<meta charset="utf-8"><table>${html}</table>`;
  } else {
    /** Key / Summary 之外的附加信息（Start/End 合并成一段人可读的区间） */
    const extra = (r: CopyRow): string[] =>
      cols
        .filter(([k]) => !['key', 'summary'].includes(k))
        .map(([k]) =>
          k === 'start'
            ? r.start && r.end
              ? `${fmtMD(r.start)} → ${fmtMD(r.end)}`
              : ''
            : k === 'end'
              ? ''
              : view === 'dependency' && cellVal(r, k)
                ? `${cols.find(([key]) => key === k)![1]}: ${cellVal(r, k)}`
                : cellVal(r, k),
        )
        .filter((x) => x && x.trim())
        .map(cpCell);
    const liHtml = (r: CopyRow) => {
      const x = extra(r);
      return `${link(r.key)} ${esc(r.summary)}${
        x.length
          ? ` <span style="color:#717A86">· ${esc(x.join(' · '))}</span>`
          : ''
      }`;
    };
    const liText = (r: CopyRow) => {
      const x = extra(r);
      return `${r.key || (view === 'dependency' ? '手动依赖' : 'DRAFT')} ${cpCell(r.summary)}${
        x.length ? ` · ${x.join(' · ')}` : ''
      }`;
    };
    for (const g of data.groups) {
      if (grouped) {
        html += `<p><b>${esc(g.name || '')}</b> (${g.rows.length})</p>`;
        text += `${cpCell(g.name)} (${g.rows.length})\n`;
      }
      html += listHtml(g.rows, liHtml);
      for (const r of g.rows) text += `${r.lvl ? '    ' : ''}- ${liText(r)}\n`;
      if (grouped) text += '\n';
    }
  }

  const lines = data.groups.reduce((a, g) => a + g.rows.length, 0);
  return { html, text: text.replace(/\n+$/, '\n'), lines };
}

/* ---------- 写剪贴板：一次写入 html + plain ---------- */

/**
 * 在用户手势里同步触发 copy 事件，把 text/html 与 text/plain 一次写进剪贴板
 * （http:// 页面上 navigator.clipboard 常不可用，execCommand 路径兜底；
 * 反之 execCommand 失败时再试异步 ClipboardItem）。
 */
export function writeRichClipboard(payload: CopyPayload): boolean {
  let ok = false;
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    e.clipboardData?.setData('text/html', payload.html);
    e.clipboardData?.setData('text/plain', payload.text);
    ok = true;
  };
  document.addEventListener('copy', onCopy, { once: true });
  try {
    document.execCommand('copy');
  } catch {
    /* older browsers */
  }
  document.removeEventListener('copy', onCopy);
  if (
    !ok &&
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof ClipboardItem !== 'undefined'
  ) {
    try {
      navigator.clipboard
        .write([
          new ClipboardItem({
            'text/html': new Blob([payload.html], { type: 'text/html' }),
            'text/plain': new Blob([payload.text], { type: 'text/plain' }),
          }),
        ])
        .catch(() => undefined);
      ok = true;
    } catch {
      /* permission denied — caller shows the manual-copy fallback */
    }
  }
  return ok;
}

/* ---------- 响应式装配 ---------- */

export function useCopyExport() {
  const state = useRoadmapState();
  const jiraBase = computed(
    () =>
      state.snapshot.value?.team.jiraBaseUrl || 'https://jira.ringcentral.com',
  );
  const assigneeMap = computed(() => teamAssigneeMap(state.snapshot.value));
  const showName = (raw: string | null | undefined) =>
    dispName(assigneeMap.value, raw);

  const options = reactive(loadCopyOptions()) as Record<CopyView, CopyOptions>;

  function setOpt(view: CopyView, key: keyof CopyOptions, value: unknown) {
    (options[view] as unknown as Record<string, unknown>)[key] = value;
    saveCopyOptions(options);
  }

  const view = computed<CopyView>(() => state.view.value);
  const msNames = computed<string | null>(() =>
    state.msActive.value
      ? state.msSel.value
          .map(
            (k) => state.milestones.value.find((m) => m.key === k)?.name || k,
          )
          .join(' / ')
      : null,
  );
  const win = computed<{ s: Date; e: Date } | null>(() => {
    if (
      view.value !== 'resource' ||
      state.resWin.value !== '2w' ||
      !options.resource.winOnly
    ) {
      return null;
    }
    const s = addD(today, state.resOffset.value);
    return { s, e: addD(s, 13) };
  });
  const data = computed<CopyData>(() =>
    collectCopyData({
      view: view.value,
      dependencyFilter: state.dependencyFilter.value,
      items: state.scheduledItems.value,
      members: state.snapshot.value?.members || [],
      includeSubs: options.gantt.subs,
      search: state.searchQuery.value,
      msNames: msNames.value,
      win: win.value,
      resWinAll: state.resWin.value === 'all',
      epicMatch: (it) => state.viewMatch(it),
      showName,
    }),
  );
  const payload = computed<CopyPayload>(() =>
    buildCopyPayload(
      data.value,
      options[view.value],
      view.value,
      jiraBase.value,
    ),
  );

  function copyNow(): { ok: boolean } {
    if (!data.value.n) return { ok: false };
    return { ok: writeRichClipboard(payload.value) };
  }

  return { state, view, options, data, payload, msNames, copyNow, setOpt };
}
