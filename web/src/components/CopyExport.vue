<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fmtMD } from '../composables/useGeometry';
import { jiraBrowseUrl } from '../composables/useRoadmapContract';
import {
  copyColumns,
  useCopyExport,
  type CopyNote,
  type CopyOptions,
  type CopyRow,
  type CopyView,
} from '../composables/useCopyExport';

/**
 * 复制导出按钮（过滤行最右）+ 回执卡。交互流程（与 docs/demo/roadmap-demo.html
 * 的 cp-* 区块一致）：
 * - 主按钮一键复制（任务视图 = 甘特上的 Epic；人员视图 = 按人分组的 Task；
 *   Milestone / 搜索过滤后只复制过滤结果），按钮原地变绿 ✓。
 * - 箭头打开配置卡：先调附加列与「粘贴到」格式，预览前 6 行（带列字母），
 *   点「复制 N 行」才写入剪贴板。
 * - 复制成功后的回执卡不再预览 Ticket 内容，只说明列结构；勾选任何附加列
 *   会立即重写剪贴板（「已更新剪贴板」），没有第二步确认。选项按视图记住。
 * - 成功回执 8 秒后自动收起（底部倒计时细线），悬停 / 聚焦即视为要继续调整，
 *   改为常驻。写入失败时展示已全选的文本框，⌘C/Ctrl+C 手动复制。
 * - Esc 关闭并还焦点；卡片外点击关闭；视图切换（任务 ↔ 人员）时关闭。
 */
const cp = useCopyExport();
const state = cp.state;

const splitEl = ref<HTMLElement | null>(null);
const mainBtnEl = ref<HTMLElement | null>(null);
const popEl = ref<HTMLElement | null>(null);
const fallbackTa = ref<HTMLTextAreaElement | null>(null);

const open = ref(false);
const shown = ref(false);
const mode = ref<'config' | 'receipt'>('config');
/** 弹窗打开时绑定的视图；视图切换即关闭，因此卡内始终用它 */
const popView = ref<CopyView>('gantt');
const result = ref<{ ok: boolean } | null>(null);
const flash = ref(false);
const doneFlash = ref(false);
const label = ref('复制');
const timerOn = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let doneTimer: ReturnType<typeof setTimeout> | null = null;

const data = cp.data;
const o = computed<CopyOptions>(() => cp.options[popView.value]);
const isReceipt = computed(() => mode.value === 'receipt');
const isErr = computed(
  () => isReceipt.value && !!result.value && !result.value.ok && data.value.n > 0,
);
const isReceiptOk = computed(
  () => isReceipt.value && !!result.value?.ok && data.value.n > 0,
);
const grouped = computed(
  () => popView.value === 'resource' && o.value.asgMode === 'group',
);

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const pasteKeys = isMac ? '<kbd>⌘</kbd> <kbd>V</kbd>' : '<kbd>Ctrl</kbd> <kbd>V</kbd>';
const copyKeys = isMac ? '<kbd>⌘</kbd> <kbd>C</kbd>' : '<kbd>Ctrl</kbd> <kbd>C</kbd>';

const countText = computed(() =>
  data.value.n ? `${data.value.n} ${data.value.unit}` : '',
);

const mainTip = computed(() => {
  const d = data.value;
  if (cp.view.value === 'dependency') return d.n ? `复制当前筛选下的 ${d.n} 个依赖||所属任务 · 期望日期 · ETA · 风险 · Ticket Target 排期||右侧箭头可切换列表或表格` : '当前没有可复制的依赖';
  if (!d.n) {
    return `${
      cp.view.value === 'gantt' ? '甘特图上还没有 Epic' : '当前没有可复制的 Task'
    }||点击查看说明`;
  }
  const fl = [
    state.msActive.value && 'Milestone',
    state.searchQuery.value.trim() && '搜索',
  ]
    .filter(Boolean)
    .join(' + ');
  const what =
    (fl ? `${fl} 过滤后` : '') +
    (cp.view.value === 'gantt'
      ? `甘特图上的 ${d.n} 个 Epic${cp.options.gantt.subs ? '（含子任务）' : ''}`
      : `按人分组的 ${d.n} 个 Task`);
  const fmtLine =
    cp.options[cp.view.value].fmt === 'table'
      ? 'Key（带 Jira 链接）⇥ Summary，粘贴到 Google Sheet 自动分列'
      : 'Key（带 Jira 链接）+ Summary，每行一条，可直接粘贴到文档 / 聊天';
  return `复制${what}||${fmtLine}||右侧箭头：附加子任务 / Assignee / 状态 / 排期，可切换 Sheet 表格与列表`;
});

const head = computed<{ title: string; sub: string }>(() => {
  const d = data.value;
  if (!d.n) {
    return d.filtered
      ? {
          title: '筛选后没有可复制的条目',
          sub: '复制只包含 Milestone / 搜索过滤后的结果，调整或清除筛选后再试',
        }
      : cp.view.value === 'gantt'
        ? {
            title: '甘特图上还没有 Epic',
            sub: '把左侧 Backlog 卡片拖进时间轴后，这里就能一键复制',
          }
        : {
            title: cp.view.value === 'dependency' ? '没有可复制的依赖' : '没有可复制的 Task',
            sub: cp.view.value === 'dependency' ? '在甘特任务条上添加外部依赖后再复制' : '任务添加 Owner 后会按人分组出现在人员视图',
          };
  }
  if (isErr.value) {
    return {
      title: '浏览器没有允许写入剪贴板',
      sub: `内容已准备好并全选，按 ${copyKeys} 手动复制即可`,
    };
  }
  if (isReceipt.value) {
    const target = o.value.fmt === 'table' ? 'Google Sheet' : '文档 / 聊天';
    return {
      title: `${flash.value ? '已更新剪贴板' : '已复制'} · <span class="num">${cp.payload.value.lines}</span> 行`,
      sub: `${
        o.value.fmt === 'table'
          ? 'Key 带 Jira 链接 · Tab 分列'
          : 'Key 带 Jira 链接 · 每行一条'
      }，到 ${target} 里 ${pasteKeys} 即可`,
    };
  }
  return {
    title:
      cp.view.value === 'gantt'
        ? `复制 ${d.n} 个 Epic${o.value.subs ? `（含 ${d.subN} 个子任务）` : ''}`
        : cp.view.value === 'dependency' ? `复制 ${d.n} 个依赖` : `复制 ${d.n} 个 Task · ${d.people} 人`,
    sub: '先调好附加列与格式，点「复制」后写入剪贴板；选项会被记住',
  };
});

const footHint = computed(() => {
  if (isErr.value) return '常见原因：页面不在前台，或浏览器策略限制';
  if (isReceiptOk.value) return '选项已记住，下次点「复制」直接带上';
  if (cp.view.value === 'dependency') return '仅复制当前筛选下的依赖，始终附带期望、ETA、风险和 ticket 排期';
  return '默认只复制 Key ⇥ Summary；「粘贴到」默认列表，贴进文档 / 聊天';
});

const emptyHtml = computed(() =>
  popView.value === 'gantt'
    ? '时间轴还是空的<br>把 <b>Backlog</b> 卡片拖进来，再回到这里复制'
    : popView.value === 'dependency' ? '当前没有依赖，请添加依赖或调整筛选' : '还没有分配到人的任务<br>在甘特子任务上设置 <b>Owner</b> 后出现在人员视图',
);

/* ---------- 回执态列结构（不预览 Ticket 内容，只说明 A/B/C 列） ---------- */

const colsLine = computed(() =>
  copyColumns(popView.value, o.value).map(([key, h], i) => ({
    key,
    label: h,
    letter: String.fromCharCode(65 + i),
  })),
);

/* ---------- 配置态预览：前 6 行（表格带列字母 / 列表带符号） ---------- */

const COL_W: Record<string, string> = {
  key: '92px',
  summary: 'minmax(140px,1fr)',
  asg: 'minmax(70px,.42fr)',
  epic: 'minmax(70px,.45fr)',
  status: '74px',
  start: '68px',
  end: '68px',
};

type PrevEntry =
  | { t: 'group'; name: string; count: number }
  | { t: 'row'; cells: Array<{ kind: 'key'; key: string | null; text?: never; cls?: never } | { kind: 'text'; text: string; cls: string; key?: never }>; title: string };

interface Preview {
  cols: Array<[string, string]>;
  tpl: string;
  headerLabels: string[] | null;
  entries: PrevEntry[];
  hidden: number;
}

const preview = computed<Preview | null>(() => {
  if (!open.value || isReceipt.value || !data.value.n) return null;
  const view = popView.value;
  const cols = copyColumns(view, o.value);
  const last = (i: number) => (i === cols.length - 1 ? ' last' : '');
  const entries: PrevEntry[] = [];
  const MAX = 6;
  let shownRows = 0;
  let hidden = 0;

  if (o.value.fmt === 'table') {
    for (const g of data.value.groups) {
      if (grouped.value && shownRows < MAX) {
        entries.push({ t: 'group', name: g.name || '', count: g.rows.length });
      }
      for (const r of g.rows) {
        if (shownRows >= MAX) {
          hidden += 1;
          continue;
        }
        shownRows += 1;
        entries.push({
          t: 'row',
          title: r.summary,
          cells: cols.map(([k], i) => {
            if (k === 'key') return { kind: 'key', key: r.key } as const;
            const base =
              k === 'start' || k === 'end'
                ? 'mono'
                : r.lvl && k === 'summary'
                  ? 'sub'
                  : '';
            return {
              kind: 'text',
              text: k === 'summary' ? r.summary : cellOf(r, k),
              cls: `${k === 'key' ? 'k' : base}${last(i)}`,
            } as const;
          }),
        });
      }
    }
    return {
      cols,
      tpl: cols.map(([k]) => COL_W[k] || '90px').join(' '),
      headerLabels: o.value.header ? cols.map(([, h]) => h) : null,
      entries,
      hidden,
    };
  }

  /* 列表格式预览 */
  const extras = (r: CopyRow): string[] =>
    cols
      .filter(([k]) => !['key', 'summary', 'end'].includes(k))
      .map(([k]) =>
        k === 'start'
          ? r.start && r.end
            ? `${fmtMD(r.start)} → ${fmtMD(r.end)}`
            : ''
          : cellOf(r, k),
      )
      .filter((x) => x && x.trim());
  for (const g of data.value.groups) {
    if (grouped.value && shownRows < MAX) {
      entries.push({ t: 'group', name: g.name || '', count: g.rows.length });
    }
    for (const r of g.rows) {
      if (shownRows >= MAX) {
        hidden += 1;
        continue;
      }
      shownRows += 1;
      entries.push({
        t: 'row',
        title: r.summary,
        cells: [
          { kind: 'key', key: r.key } as const,
          { kind: 'text', text: r.summary, cls: r.lvl ? 'l1' : '' } as const,
          { kind: 'text', text: extras(r).join(' · '), cls: 'x' } as const,
        ],
      });
    }
  }
  return { cols, tpl: '', headerLabels: null, entries, hidden };
});

function cellOf(r: CopyRow, k: string): string {
  if (['need', 'eta', 'risk', 'targetStart', 'targetEnd'].includes(k)) return String(r[k as keyof CopyRow] || '');
  if (k === 'asg') return r.asg;
  if (k === 'epic') return r.epic;
  if (k === 'status') return r.status;
  if (k === 'start' || k === 'end') return r[k] || '';
  return '';
}

function keyHref(key: string) {
  return jiraBrowseUrl(
    key,
    state.snapshot.value?.team.jiraBaseUrl || 'https://jira.ringcentral.com',
  );
}

/* ---------- 复制 / 开关 / 定时 ---------- */

function doCopy(): boolean {
  const r = cp.copyNow();
  result.value = r;
  if (r.ok) {
    doneFlash.value = false;
    label.value = '已复制';
    void splitEl.value?.offsetWidth;
    nextTick(() => {
      doneFlash.value = true;
    });
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      doneFlash.value = false;
      label.value = '复制';
    }, 1600);
  }
  return r.ok;
}

function armTimer(on: boolean) {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  timerOn.value = on;
  if (on) closeTimer = setTimeout(() => closePop(), 8000);
}

/** 悬停 / 聚焦卡片：视为要继续调整，倒计时停止（下次复制再重新计时） */
function engage() {
  if (open.value && closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
    timerOn.value = false;
  }
}

function openPop(next: 'config' | 'receipt') {
  const wasOpen = open.value;
  open.value = true;
  mode.value = next;
  popView.value = cp.view.value;
  flash.value = false;
  if (!wasOpen) {
    shown.value = false;
    nextTick(() => {
      place();
      requestAnimationFrame(() => {
        shown.value = true;
      });
    });
  }
  armTimer(next === 'receipt' && !!result.value?.ok);
}

function closePop(refocus?: boolean) {
  if (!open.value) return;
  open.value = false;
  armTimer(false);
  shown.value = false;
  if (refocus) mainBtnEl.value?.focus();
}

function onMainClick() {
  if (!data.value.n) {
    doneFlash.value = false;
    label.value = '复制';
    openPop('config');
    return;
  }
  doCopy();
  openPop('receipt');
}

function onMoreClick() {
  if (open.value) closePop();
  else openPop('config');
}

function onGo() {
  if (!data.value.n) return;
  doCopy();
  mode.value = 'receipt';
  flash.value = false;
  armTimer(!!result.value?.ok);
}

/** 勾选 / 切换即重写剪贴板（仅在已复制过的回执态；配置态只改预览） */
function setOpt(key: keyof CopyOptions, value: unknown) {
  const cur = o.value[key];
  if (cur === value) return;
  cp.setOpt(popView.value, key, value);
  if (isReceipt.value && data.value.n) {
    doCopy();
    flash.value = true;
  }
}

function applyNote(note: CopyNote) {
  if (note.act?.kind === 'winOnly') setOpt('winOnly', note.act.value);
}

/* ---------- 定位 / 全局事件 ---------- */

function place() {
  const el = popEl.value;
  const sp = splitEl.value;
  if (!el || !sp) return;
  const r = sp.getBoundingClientRect();
  el.style.top = `${r.bottom + 8}px`;
  el.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
}

function onResize() {
  if (open.value) place();
}

function onOutsidePointerDown(ev: PointerEvent) {
  if (!open.value) return;
  const target = ev.target as HTMLElement | null;
  if (target?.closest('.cp-pop, .cp-split')) return;
  closePop();
}

function onKeydown(ev: KeyboardEvent) {
  if (!open.value || ev.key !== 'Escape') return;
  ev.stopPropagation();
  closePop(true);
}

watch(cp.view, () => {
  if (open.value) closePop();
});

watch(isErr, async (err) => {
  if (!err) return;
  await nextTick();
  fallbackTa.value?.focus();
  fallbackTa.value?.select();
});

onMounted(() => {
  window.addEventListener('resize', onResize);
  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
  if (closeTimer) clearTimeout(closeTimer);
  if (doneTimer) clearTimeout(doneTimer);
});
</script>

<template>
  <div
    ref="splitEl"
    class="cp-split"
    :class="{ empty: !data.n, done: doneFlash }"
  >
    <button
      ref="mainBtnEl"
      class="cp-main"
      type="button"
      :data-tip="mainTip"
      @click="onMainClick"
    >
      <span class="cp-ico" aria-hidden="true">
        <svg class="i-copy" width="14" height="14" viewBox="0 0 14 14">
          <rect
            x="4.5"
            y="4.5"
            width="7.5"
            height="7.5"
            rx="1.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="M9.5 4.5V3.2A1.2 1.2 0 008.3 2H3.2A1.2 1.2 0 002 3.2v5.1a1.2 1.2 0 001.2 1.2h1.3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
        </svg>
        <svg class="i-ok" width="14" height="14" viewBox="0 0 14 14">
          <path
            d="M2.5 7.4l3 3 6-6.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <span class="cp-label">{{ label }}</span>
      <span class="cp-n">{{ countText }}</span>
    </button>
    <button
      class="cp-more"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="open"
      aria-controls="cpPop"
      aria-label="复制选项"
      @click="onMoreClick"
    >
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d="M2 4l4 4 4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>

  <div
    v-if="open"
    ref="popEl"
    class="cp-pop"
    :class="{ show: shown, ok: isReceiptOk, err: isErr }"
    role="dialog"
    aria-label="复制导出"
    @mouseenter="engage"
    @focusin="engage"
  >
    <div class="cp-head">
      <span class="cp-badge" :class="{ bump: isReceiptOk }">
        <svg v-if="isErr" viewBox="0 0 14 14">
          <path
            d="M7 3.2v4.6M7 10.4v.01"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
        <svg v-else-if="isReceiptOk" viewBox="0 0 14 14">
          <path
            d="M2.5 7.4l3 3 6-6.6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg v-else viewBox="0 0 14 14">
          <rect
            x="4.5"
            y="4.5"
            width="7.5"
            height="7.5"
            rx="1.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="M9.5 4.5V3.2A1.2 1.2 0 008.3 2H3.2A1.2 1.2 0 002 3.2v5.1a1.2 1.2 0 001.2 1.2h1.3"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
        </svg>
      </span>
      <div role="status" aria-live="polite">
        <div class="cp-ttl" v-html="head.title"></div>
        <div class="cp-sub" v-html="head.sub"></div>
      </div>
      <button type="button" class="cp-x" aria-label="关闭" @click="closePop(true)">
        ×
      </button>
    </div>

    <div v-if="data.notes.length" class="cp-scope">
      <div
        v-for="(n, i) in data.notes"
        :key="i"
        class="cp-note"
        :class="n.cls"
      >
        <i aria-hidden="true" />
        <span v-html="n.html"></span>
        <button v-if="n.act" type="button" @click="applyNote(n)">
          {{ n.act.kind === 'winOnly' ? (n.act.value ? '仅时间窗内' : '复制全部时间') : '' }}
        </button>
      </div>
    </div>

    <textarea
      v-if="isErr"
      ref="fallbackTa"
      class="cp-fallback"
      readonly
      aria-label="待复制内容"
      :value="cp.payload.value.text"
    ></textarea>
    <div v-else-if="isReceipt && data.n" class="cp-cols">
      <span v-if="o.fmt === 'list'" class="g">列表 · 每行一条</span>
      <span v-else-if="grouped" class="g">按人分组标题行</span>
      <span v-for="c in colsLine" :key="c.key">
        <em>{{ c.letter }}</em>{{ c.label }}
      </span>
    </div>
    <div v-else-if="preview" class="cp-prev" :class="{ list: o.fmt === 'list' }">
      <template v-if="o.fmt === 'table'">
        <div class="cp-grid" :style="{ gridTemplateColumns: preview.tpl }">
          <div
            v-for="(c, i) in preview.cols"
            :key="`h-${c[0]}`"
            class="ch"
            :class="{ last: i === preview.cols.length - 1 }"
          >
            <em>{{ String.fromCharCode(65 + i) }}</em
            >{{ preview.headerLabels ? c[1].toUpperCase() : '' }}
          </div>
          <template v-if="preview.headerLabels">
            <div
              v-for="(lab, i) in preview.headerLabels"
              :key="`hl-${lab}`"
              :class="{ last: i === preview.cols.length - 1 }"
              style="font-weight: 600"
            >
              {{ lab }}
            </div>
          </template>
          <template v-for="(e, ei) in preview.entries" :key="`e-${ei}`">
            <div v-if="e.t === 'group'" class="grp">
              {{ e.name }}<span>({{ e.count }})</span>
            </div>
            <template v-else>
              <div
                v-for="(cell, ci) in e.cells"
                :key="`c-${ei}-${ci}`"
                :class="cell.kind === 'key' ? 'k' : cell.cls"
                :title="cell.kind !== 'key' && ci === 1 ? e.title : undefined"
              >
                <template v-if="cell.kind === 'key'">
                  <a v-if="cell.key" :href="keyHref(cell.key)" target="_blank" rel="noopener">{{ cell.key }}</a>
                  <span v-else class="dr">{{ popView === 'dependency' ? '手动依赖' : 'DRAFT' }}</span>
                </template>
                <template v-else>{{ cell.text }}</template>
              </div>
            </template>
          </template>
        </div>
      </template>
      <template v-else>
        <div class="cp-list">
          <template v-for="(e, ei) in preview.entries" :key="`e-${ei}`">
            <div v-if="e.t === 'group'" class="li g">
              {{ e.name }} <span class="x">({{ e.count }})</span>
            </div>
            <div v-else class="li" :class="{ l1: e.cells[1].cls === 'l1' }">
              {{ e.cells[1].cls === 'l1' ? '◦ ' : '• ' }}
              <template v-if="e.cells[0].kind === 'key'">
                <a v-if="e.cells[0].key" :href="keyHref(e.cells[0].key)" target="_blank" rel="noopener">{{ e.cells[0].key }}</a>
                <span v-else class="dr">{{ popView === 'dependency' ? '手动依赖' : 'DRAFT' }}</span>
              </template>
              <span class="sum">{{ e.cells[1].text }}</span>
              <span v-if="e.cells[2].text" class="x"> · {{ e.cells[2].text }}</span>
            </div>
          </template>
        </div>
      </template>
      <div v-if="preview.hidden" class="cp-more-rows">… 还有 {{ preview.hidden }} 行</div>
    </div>
    <div v-else-if="!data.filtered" class="cp-prev">
      <div class="cp-empty" v-html="emptyHtml"></div>
    </div>

    <template v-if="data.n">
      <div v-if="popView !== 'dependency'" class="cp-sec">
        附加信息
        <span>{{ isReceipt && !isErr ? '勾选后剪贴板立即更新' : '可多选' }}</span>
      </div>
      <div v-if="popView !== 'dependency'" class="cp-opts">
        <template v-if="popView === 'gantt'">
          <button
            type="button"
            class="cp-chip"
            :aria-pressed="o.subs"
            @click="setOpt('subs', !o.subs)"
          >
            <span class="box">
              <svg width="9" height="9" viewBox="0 0 10 10">
                <path
                  d="M2 5.2l2 2 4-4.4"
                  fill="none"
                  stroke="#fff"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            子任务 <span class="c">{{ data.subN }}</span>
          </button>
          <button
            type="button"
            class="cp-chip"
            :aria-pressed="o.asg"
            @click="setOpt('asg', !o.asg)"
          >
            <span class="box">
              <svg width="9" height="9" viewBox="0 0 10 10">
                <path
                  d="M2 5.2l2 2 4-4.4"
                  fill="none"
                  stroke="#fff"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            Assignee
          </button>
        </template>
        <template v-else>
          <button
            type="button"
            class="cp-chip"
            :aria-pressed="o.epic"
            @click="setOpt('epic', !o.epic)"
          >
            <span class="box">
              <svg width="9" height="9" viewBox="0 0 10 10">
                <path
                  d="M2 5.2l2 2 4-4.4"
                  fill="none"
                  stroke="#fff"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            所属 Epic
          </button>
        </template>
        <button
          type="button"
          class="cp-chip"
          :aria-pressed="o.status"
          @click="setOpt('status', !o.status)"
        >
          <span class="box">
            <svg width="9" height="9" viewBox="0 0 10 10">
              <path
                d="M2 5.2l2 2 4-4.4"
                fill="none"
                stroke="#fff"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          状态
        </button>
        <button
          type="button"
          class="cp-chip"
          :aria-pressed="o.dates"
          @click="setOpt('dates', !o.dates)"
        >
          <span class="box">
            <svg width="9" height="9" viewBox="0 0 10 10">
              <path
                d="M2 5.2l2 2 4-4.4"
                fill="none"
                stroke="#fff"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          排期
        </button>
        <button
          type="button"
          class="cp-chip"
          :aria-pressed="o.header"
          @click="setOpt('header', !o.header)"
        >
          <span class="box">
            <svg width="9" height="9" viewBox="0 0 10 10">
              <path
                d="M2 5.2l2 2 4-4.4"
                fill="none"
                stroke="#fff"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          表头行
        </button>
      </div>
      <div v-if="popView === 'resource'" class="cp-row">
        <span class="lb">按人</span>
        <div class="cp-seg" role="group" aria-label="人员呈现方式">
          <button
            type="button"
            :class="{ on: o.asgMode === 'group' }"
            :aria-pressed="o.asgMode === 'group'"
            @click="setOpt('asgMode', 'group')"
          >
            分组标题行
          </button>
          <button
            type="button"
            :class="{ on: o.asgMode === 'col' }"
            :aria-pressed="o.asgMode === 'col'"
            @click="setOpt('asgMode', 'col')"
          >
            Assignee 列
          </button>
        </div>
      </div>
      <div class="cp-row">
        <span class="lb">粘贴到</span>
        <div class="cp-seg" role="group" aria-label="粘贴格式">
          <button
            type="button"
            :class="{ on: o.fmt === 'table' }"
            :aria-pressed="o.fmt === 'table'"
            @click="setOpt('fmt', 'table')"
          >
            表格 · Sheet
          </button>
          <button
            type="button"
            :class="{ on: o.fmt === 'list' }"
            :aria-pressed="o.fmt === 'list'"
            @click="setOpt('fmt', 'list')"
          >
            列表 · 文档 / 聊天
          </button>
        </div>
      </div>
    </template>

    <div class="cp-foot">
      <span class="hint">{{ footHint }}</span>
      <button
        v-if="data.n"
        type="button"
        class="btn"
        :class="isReceipt && !isErr ? 'btn-ghost' : 'btn-primary'"
        @click="onGo"
      >
        {{ isReceipt ? '再次复制' : `复制 ${cp.payload.value.lines} 行` }}
      </button>
    </div>
    <div class="cp-timer" :class="{ run: timerOn }"></div>
  </div>
</template>
