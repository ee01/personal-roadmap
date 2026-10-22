import { describe, expect, it } from 'vitest';
import {
  buildCopyPayload,
  collectCopyData,
  copyColumns,
  cpCell,
  loadCopyOptions,
  type CopyCollectInput,
  type CopyData,
  type CopyOptions,
} from '../composables/useCopyExport';
import type { RoadmapItem, RoadmapSub, TeamMember } from '../types';

function sub(overrides: Partial<RoadmapSub> = {}): RoadmapSub {
  return {
    id: 's1',
    key: 'NOVA-10',
    title: 'Task A',
    alias: null,
    owner: 'Kevin Liu',
    start: '2026-07-02',
    days: 3,
    temp: false,
    createdBy: 'x',
    version: 1,
    ...overrides,
  };
}

function epic(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    key: 'LOCAL-1',
    type: 'Epic',
    title: 'Alpha epic',
    source: 'jira',
    jiraKey: 'NOVA-1',
    projectKey: 'NOVA',
    alias: null,
    quarter: '2026-Q3',
    estimate: 2,
    targetStart: null,
    targetEnd: null,
    scheduled: true,
    start: '2026-07-01',
    days: 14,
    lane: 1,
    expanded: false,
    version: 3,
    subs: [],
    markers: [],
    ms: [],
    ...overrides,
  };
}

function input(
  overrides: Partial<CopyCollectInput> = {},
): CopyCollectInput {
  return {
    view: 'gantt',
    items: [],
    members: [],
    includeSubs: false,
    search: '',
    msNames: null,
    win: null,
    resWinAll: false,
    epicMatch: () => true,
    showName: (raw) => raw || '',
    ...overrides,
  };
}

const OPTS = (o: Partial<CopyOptions> = {}): CopyOptions => ({
  subs: false,
  asg: false,
  asgMode: 'group',
  epic: false,
  status: false,
  dates: false,
  header: false,
  fmt: 'list',
  winOnly: true,
  ...o,
});

describe('copy options defaults', () => {
  it('「粘贴到」默认选中列表 · 文档 / 聊天（两种视图）', () => {
    expect(loadCopyOptions().gantt.fmt).toBe('list');
    expect(loadCopyOptions().resource.fmt).toBe('list');
    expect(loadCopyOptions().resource.asgMode).toBe('group');
    expect(loadCopyOptions().resource.winOnly).toBe(true);
  });
});

describe('collectCopyData · 甘特视图', () => {
  const items = [
    epic({
      key: 'LOCAL-1',
      jiraKey: 'NOVA-1',
      title: 'Alpha',
      alias: 'A',
      subs: [
        sub({ id: 's1', key: 'NOVA-10', title: 'Task A', owner: 'Kevin Liu', start: '2026-07-02' }),
        sub({ id: 's2', key: 'NOVA-11', title: 'Task B', owner: 'Vivi Wang', start: '2026-07-01' }),
      ],
    }),
    epic({
      key: 'LOCAL-2',
      jiraKey: null,
      title: 'Beta draft',
      alias: null,
      subs: [sub({ id: 's3', key: null, temp: true, title: 'Draft task', start: '2026-07-05' })],
    }),
    epic({ key: 'LOCAL-3', jiraKey: 'NOVA-3', title: 'Cleared', subs: [] }),
  ];

  it('复制甘特上的 Epic；草稿 Key 为 null 并计入提示', () => {
    const d = collectCopyData(input({ items }));
    expect(d.unit).toBe('Epic');
    expect(d.n).toBe(3);
    const rows = d.groups[0].rows;
    expect(rows.map((r) => r.key)).toEqual(['NOVA-1', null, 'NOVA-3']);
    expect(rows[1].status).toBe('Draft');
    expect(d.notes.some((n) => /2 条为草稿/.test(n.html))).toBe(false); // 未勾子任务 → 只有 Epic 本身是草稿
    expect(d.notes.some((n) => /1 条为草稿/.test(n.html))).toBe(true);
  });

  it('勾「子任务」后按开始日排序带出子任务行，Assignee 取子任务 Owner 并集', () => {
    const d = collectCopyData(
      input({ items, includeSubs: true }),
    );
    const rows = d.groups[0].rows;
    expect(d.subN).toBe(3);
    // Alpha 的两个子任务按开始日升序，排在 Epic 行后
    expect(rows.slice(1, 3).map((r) => r.lvl)).toEqual([1, 1]);
    expect(rows.slice(1, 3).map((r) => r.key)).toEqual(['NOVA-11', 'NOVA-10']);
    expect(rows[0].asg).toBe('Vivi Wang, Kevin Liu'); // 按排序后的子任务取 Owner 并集
    expect(rows[0].summary).toBe('Alpha');
    expect(rows[0].end).toBe('2026-07-14');
  });

  it('搜索命中 Epic 本身 → 带全部子任务；仅子任务命中 → 只带命中的子任务', () => {
    const d = collectCopyData(
      input({
        items,
        search: 'alpha',
        epicMatch: (it) => it.title === 'Alpha', // 模拟 viewMatch
      }),
    );
    expect(d.n).toBe(1);
    expect(d.groups[0].rows.map((r) => r.key)).toEqual(['NOVA-1']);

    const d2 = collectCopyData(
      input({
        items,
        search: 'task b',
        includeSubs: true,
        epicMatch: (it) =>
          it.subs.some((s) => /task b/i.test(s.title)), // viewMatch：子任务命中保留父条目
      }),
    );
    expect(d2.n).toBe(1);
    expect(d2.groups[0].rows.map((r) => r.key)).toEqual(['NOVA-1', 'NOVA-11']);
    expect(d2.notes[0].html).toContain('已按筛选复制');
    expect(d2.notes[0].html).toContain('搜索');
    expect(d2.notes[0].html).toContain('1 / 3 个 Epic');
  });

  it('Milestone 过滤说明拼接选中名称', () => {
    const d = collectCopyData(
      input({ items, msNames: 'AIR 2.0 Beta', epicMatch: (it) => it.key === 'LOCAL-1' }),
    );
    expect(d.notes[0].html).toContain('Milestone「<b>AIR 2.0 Beta</b>」');
    expect(d.notes[0].html).toContain('1 / 3 个 Epic');
    expect(d.filtered).toBe(true);
  });
});

describe('collectCopyData · 人员视图', () => {
  const members: TeamMember[] = [
    { id: 'm1', name: 'Kevin Liu', avatarColor: '#0684BC' },
    { id: 'm2', name: 'Vivi Wang', avatarColor: '#E4708A' },
  ];
  const items = [
    epic({
      key: 'LOCAL-1',
      jiraKey: 'NOVA-1',
      title: 'Alpha',
      alias: 'A',
      subs: [
        sub({ id: 's1', key: 'NOVA-10', title: 'Task A', owner: 'Kevin Liu', start: '2026-07-02', days: 2 }),
        sub({ id: 's2', key: 'NOVA-11', title: 'Task B', owner: 'Vivi Wang', start: '2026-07-10', days: 2 }),
        sub({ id: 's3', key: 'NOVA-12', title: 'Task C', owner: null, start: '2026-07-04', days: 2 }),
      ],
    }),
  ];

  it('按人分组 + 未分配，行按开始日排序，附时间窗说明（可一键放宽）', () => {
    const d = collectCopyData(
      input({
        view: 'resource',
        items,
        members,
        win: {
          s: new Date(2026, 6, 1),
          e: new Date(2026, 6, 14),
        },
      }),
    );
    expect(d.unit).toBe('Task');
    expect(d.n).toBe(3);
    expect(d.people).toBe(3); // Kevin + Vivi + 未分配
    expect(d.groups.map((g) => g.name)).toEqual(['Kevin Liu', 'Vivi Wang', '未分配']);
    expect(d.groups[0].rows.map((r) => r.key)).toEqual(['NOVA-10']);
    expect(d.groups[0].rows[0].epic).toBe('A');
    const winNote = d.notes.find((n) => n.cls === 'win')!;
    expect(winNote.html).toContain('仅时间窗内');
    expect(winNote.act).toEqual({ kind: 'winOnly', value: false });
  });

  it('时间窗外与窗口内无法判定排期的任务都被排除', () => {
    const d = collectCopyData(
      input({
        view: 'resource',
        items,
        members,
        win: { s: new Date(2026, 6, 1), e: new Date(2026, 6, 5) },
      }),
    );
    // 7/10 开始的 Task B 在窗外；7/2 与 7/4 在窗内
    expect(d.n).toBe(2);
    expect(d.groups.map((g) => g.rows.map((r) => r.key))).toEqual([
      ['NOVA-10'],
      ['NOVA-12'],
    ]);
  });

  it('winOnly 关闭时不限时间，说明可一键收窄', () => {
    const d = collectCopyData(
      input({ view: 'resource', items, members, win: null }),
    );
    expect(d.n).toBe(3);
    const winNote = d.notes.find((n) => n.cls === 'win')!;
    expect(winNote.html).toContain('包含全部时间');
    expect(winNote.act).toEqual({ kind: 'winOnly', value: true });
  });

  it('搜索过滤只保留命中子任务，但 n/total 说明被过滤掉多少', () => {
    const d = collectCopyData(
      input({
        view: 'resource',
        items,
        members,
        win: null,
        search: 'task a nova-10',
        epicMatch: () => true, // viewMatch 口径下父条目仍命中
      }),
    );
    expect(d.n).toBe(1);
    expect(d.groups[0].rows[0].key).toBe('NOVA-10');
    expect(d.notes[0].html).toContain('1 / 3 个 Task');
  });
});

describe('copyColumns / buildCopyPayload', () => {
  const data: CopyData = {
    groups: [
      {
        name: null,
        rows: [
          {
            lvl: 0,
            key: 'NOVA-1',
            summary: 'Alpha\tsummary',
            asg: 'Kevin Liu',
            epic: 'A',
            status: 'In Progress',
            start: '2026-07-01',
            end: '2026-07-14',
          },
          {
            lvl: 1,
            key: null,
            summary: 'Draft task',
            asg: '',
            epic: 'A',
            status: 'Draft',
            start: '2026-07-02',
            end: '2026-07-04',
          },
        ],
      },
    ],
    notes: [],
    n: 1,
    unit: 'Epic',
    subN: 1,
    people: 0,
    filtered: false,
  };

  it('cpCell 把 Tab/换行压成空格，TSV 不串列', () => {
    expect(cpCell('a\tb\nc')).toBe('a b c');
  });

  it('列定义：附加列按视图依次追加在 Key/Summary 之后', () => {
    expect(copyColumns('gantt', OPTS())).toEqual([
      ['key', 'Key'],
      ['summary', 'Summary'],
    ]);
    expect(copyColumns('gantt', OPTS({ asg: true, status: true, dates: true }))).toEqual([
      ['key', 'Key'],
      ['summary', 'Summary'],
      ['asg', 'Assignee'],
      ['status', 'Status'],
      ['start', 'Start'],
      ['end', 'End'],
    ]);
    expect(copyColumns('resource', OPTS({ asgMode: 'col', epic: true }))).toEqual([
      ['key', 'Key'],
      ['summary', 'Summary'],
      ['asg', 'Assignee'],
      ['epic', 'Epic'],
    ]);
  });

  it('表格：Tab 分列、表头、DRAFT、Key 带 Jira 链接', () => {
    const p = buildCopyPayload(
      data,
      OPTS({ fmt: 'table', header: true, asg: true }),
      'gantt',
      'https://jira.example.com',
    );
    expect(p.lines).toBe(2);
    expect(p.text.split('\n')[0]).toBe('Key\tSummary\tAssignee');
    expect(p.text.split('\n')[1]).toBe('NOVA-1\tAlpha summary\tKevin Liu');
    expect(p.text).toContain('DRAFT\t↳ Draft task');
    expect(p.html).toContain('<meta charset="utf-8"><table>');
    expect(p.html).toContain(
      '<a href="https://jira.example.com/browse/NOVA-1">NOVA-1</a>',
    );
    expect(p.html).not.toContain('href="https://jira.example.com/browse/DRAFT"');
  });

  it('列表（默认）：每行一条、子任务缩进、无链接的草稿、附加信息并入行尾', () => {
    const p = buildCopyPayload(
      data,
      OPTS({ fmt: 'list', status: true, dates: true }),
      'gantt',
      'https://jira.example.com',
    );
    const lines = p.text.split('\n').filter(Boolean);
    expect(lines[0]).toBe(
      '- NOVA-1 Alpha summary · In Progress · 07-01 → 07-14',
    );
    expect(lines[1]).toBe('    - DRAFT Draft task · Draft · 07-02 → 07-04');
    expect(p.html).toContain('<ul><li>');
    expect(p.html).toContain('<ul><li>DRAFT');
    expect(p.html).not.toContain('<table>');
  });

  it('人员视图分组列表：人名行 + 组间空行', () => {
    const grouped: CopyData = {
      groups: [
        {
          name: 'Kevin Liu',
          rows: [
            {
              lvl: 0,
              key: 'NOVA-10',
              summary: 'Task A',
              asg: 'Kevin Liu',
              epic: 'A',
              status: '',
              start: null,
              end: null,
            },
          ],
        },
      ],
      notes: [],
      n: 1,
      unit: 'Task',
      subN: 0,
      people: 1,
      filtered: false,
    };
    const p = buildCopyPayload(grouped, OPTS(), 'resource', 'https://jira.example.com');
    expect(p.text).toBe('Kevin Liu (1)\n- NOVA-10 Task A\n');
    expect(p.html).toContain('<p><b>Kevin Liu</b> (1)</p>');
    // 分组模式（默认）下不出现 Assignee 列
    expect(copyColumns('resource', OPTS())).toEqual([
      ['key', 'Key'],
      ['summary', 'Summary'],
    ]);
  });
});

describe('dependency view copy', () => {
  const markers = [
    { id: 'late', kind: 'dep' as const, label: 'API <ready>', jiraKey: 'PLAT-1', date: '2026-08-25', need: '2026-08-20', jiraStatus: 'Open', jiraTargetStart: '2026-08-10', jiraTargetEnd: '2026-08-25', createdBy: 'x', version: 1 },
    { id: 'manual', kind: 'dep' as const, label: 'Approval', date: null, need: '2026-08-18', createdBy: 'x', version: 1 },
  ];
  it('exports visible dependencies with all dates, parent context and risk in table and list', () => {
    const data = collectCopyData(input({ view: 'dependency', items: [epic({ markers })] }));
    expect(data.n).toBe(2);
    expect(data.unit).toBe('依赖');
    const table = buildCopyPayload(data, OPTS({ fmt: 'table', header: true }), 'dependency', 'https://jira.example.com');
    expect(table.text).toContain('期望日期\tETA\t风险 / 余量');
    expect(table.text).toContain('2026-08-20\t2026-08-25\t晚 5 天');
    expect(table.text).toContain('2026-08-10\t2026-08-25');
    expect(table.text).not.toContain('DRAFT');
    expect(table.html).toContain('API &lt;ready>');
    expect(table.html).toContain('https://jira.example.com/browse/PLAT-1');
    const list = buildCopyPayload(data, OPTS(), 'dependency', 'https://jira.example.com');
    /* 列表 = 聊天文本行：依赖在前（有 ticket 带 Key），所属任务用 Jira 标题，未确认 ETA 写「未确认」 */
    expect(list.text).toBe(
      '- Depends on PLAT-1 API <ready> ： NOVA-1 Alpha epic - Expect: 2026-08-20，ETA: 2026-08-25\n'
      + '- Depends on Approval ： NOVA-1 Alpha epic - Expect: 2026-08-18，ETA: 未确认\n',
    );
    expect(list.lines).toBe(2);
    expect(list.html).toContain('<a href="https://jira.example.com/browse/PLAT-1">PLAT-1</a> API &lt;ready>');
    expect(list.html).toContain('<a href="https://jira.example.com/browse/NOVA-1">NOVA-1</a> Alpha epic');
    expect(list.text).not.toContain('DRAFT');
    expect(list.html).toContain('<ul><li>Depends on');
    expect(list.html).not.toContain('<p>*');
  });
  it('uses the Jira title (not the alias) and omits the key for draft tasks in chat lines', () => {
    const dep = [{ id: 'd', kind: 'dep' as const, label: 'Legal review', jiraKey: 'LEGAL-9', date: null, need: '2026-10-31', createdBy: 'x', version: 1 }];
    const aliased = collectCopyData(input({ view: 'dependency', items: [epic({ alias: '短名', markers: dep })] }));
    expect(buildCopyPayload(aliased, OPTS(), 'dependency', 'https://jira.example.com').text)
      .toBe('- Depends on LEGAL-9 Legal review ： NOVA-1 Alpha epic - Expect: 2026-10-31，ETA: 未确认\n');
    const draft = collectCopyData(input({ view: 'dependency', items: [epic({ source: 'manual', jiraKey: null, markers: dep } as Partial<RoadmapItem>)] }));
    expect(buildCopyPayload(draft, OPTS(), 'dependency', 'https://jira.example.com').text)
      .toBe('- Depends on LEGAL-9 Legal review ： Alpha epic - Expect: 2026-10-31，ETA: 未确认\n');
  });
  it('follows dependency risk, search/milestone filters without copying tasks or subtasks', () => {
    const data = collectCopyData(input({ view: 'dependency', dependencyFilter: 'late', items: [epic({ markers }), epic({ key: 'excluded', markers: [{ ...markers[0], label: 'hidden' }] })], epicMatch: it => it.key !== 'excluded' }));
    expect(data.n).toBe(1);
    expect(data.groups[0].rows[0].summary).toBe('API <ready>');
    expect(data.filtered).toBe(true);
  });
});
