<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import { addD, diffD, esc, fmtMD, parseDate, today } from '../composables/useGeometry';
import type { MilestoneValue } from '../types';

/**
 * Milestone 多选浮层（Custom Labels）。渐进披露：
 * 搜索 → 迷你时间轴 → 按类别分组的列表（只显示本团队条目上出现过的值）→
 * 悬停查看 Jira 原始描述与日期来源。多选 = 命中任一。
 */
const props = defineProps<{ triggerEl: HTMLElement | null }>();
const emit = defineEmits<{ (e: 'close', refocus?: boolean): void }>();

const state = useRoadmapState();
const popEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const shown = ref(false);
const search = ref('');
const kbIndex = ref(-1);
const hotKey = ref<string | null>(null);

const MS_DATE_RE =
  /^[ \t]*Milestone[ \t]*[:\-–][ \t]*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/i;

/** 每个值 key 在本团队条目上出现的次数（Filter 列表的数据来源）。 */
const countByKey = computed(() => {
  const out = new Map<string, number>();
  for (const item of state.snapshot.value?.items || []) {
    for (const key of item.ms || []) {
      out.set(key, (out.get(key) || 0) + 1);
    }
  }
  return out;
});

function dateOf(ms: MilestoneValue): Date | null {
  return ms.milestoneDate ? parseDate(ms.milestoneDate) : null;
}

function relText(date: Date): string {
  const n = diffD(today, date);
  return n === 0 ? '今天' : n > 0 ? `${n} 天后` : `${-n} 天前`;
}

interface MsOption {
  ms: MilestoneValue;
  count: number;
  date: Date | null;
}

/** 只显示本团队 ticket 上实际出现过的值；已选中但条目清零的仍保留。 */
const options = computed<MsOption[]>(() => {
  const q = search.value.trim().toLowerCase();
  return state.milestones.value
    .filter((ms) => {
      const count = countByKey.value.get(ms.key) || 0;
      if (!count && !state.msSel.value.includes(ms.key)) return false;
      if (!q) return true;
      return `${ms.name} ${ms.key} ${ms.description || ''}`
        .toLowerCase()
        .includes(q);
    })
    .map((ms) => ({
      ms,
      count: countByKey.value.get(ms.key) || 0,
      date: dateOf(ms),
    }))
    .sort(
      (a, b) =>
        (a.date ? a.date.getTime() : 9e15) -
          (b.date ? b.date.getTime() : 9e15) ||
        a.ms.name.localeCompare(b.ms.name),
    );
});

/** 按类别（Label）分组；只有一个类别时不显示分组标题。 */
const sections = computed(() => {
  const labels = new Set(options.value.map((o) => o.ms.labelName || o.ms.labelKey || ''));
  const multi = labels.size > 1;
  const byLabel = new Map<string, MsOption[]>();
  for (const opt of options.value) {
    const label = opt.ms.labelName || opt.ms.labelKey || '';
    const list = byLabel.get(label) || [];
    list.push(opt);
    byLabel.set(label, list);
  }
  return [...byLabel.entries()].map(([label, list]) => ({
    label,
    showHeader: multi,
    options: list,
  }));
});

const optElements = () =>
  popEl.value
    ? ([...popEl.value.querySelectorAll<HTMLElement>('.ms-opt')] as HTMLElement[])
    : [];

function toggle(key: string) {
  const sel = state.msSel.value;
  state.setMsSel(
    sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key],
  );
}

function setHot(key: string | null) {
  hotKey.value = key;
  popEl.value
    ?.querySelectorAll<HTMLElement>('.ms-tl-dot')
    .forEach((dot) => dot.classList.toggle('hot', dot.dataset.k === key));
}

const hotMs = computed(
  () => state.milestones.value.find((m) => m.key === hotKey.value) || null,
);

/** 描述原文，高亮被解析出日期的那一行。 */
const detailHtml = computed(() => {
  const ms = hotMs.value;
  if (!ms) {
    return {
      key: '悬停或用 ↑↓ 选中某个 milestone',
      tag: '',
      tagWarn: false,
      body: '查看它在 Jira 中的描述与日期来源。',
      muted: true,
    };
  }
  const raw = ms.description || '（无描述）';
  const escaped = esc(raw).replace(/\n+/g, ' ');
  const match = MS_DATE_RE.exec(raw);
  const body = match ? escaped.replace(esc(match[0].trim()), (s) => `<mark>${s}</mark>`) : escaped;
  const tag =
    ms.dateSource === 'duedate'
      ? '日期来自 Due Date'
      : ms.dateSource === 'targetEnd'
        ? '日期来自 Target End'
        : ms.dateSource === 'description'
          ? '日期来自 description'
          : '未识别到日期 · 展示原描述';
  return { key: ms.key, tag, tagWarn: !ms.dateSource, body, muted: false };
});

function sourceLine(): { label: string; url: string | undefined } {
  const first = state.milestones.value[0];
  const jiraBase = state.snapshot.value?.team.jiraBaseUrl || 'https://jira.ringcentral.com';
  if (first?.labelKey) {
    return {
      label: `Custom Labels · ${first.labelName || first.labelKey}`,
      url: `${jiraBase}/browse/${first.labelKey}`,
    };
  }
  return { label: 'Custom Labels', url: undefined };
}

/* ---------- 迷你时间轴 ---------- */
function timeline() {
  const dated = state.milestones.value
    .map((ms) => ({ ms, date: dateOf(ms) }))
    .filter((x): x is { ms: MilestoneValue; date: Date } => x.date !== null);
  if (!dated.length) return { ticks: [] as Array<{ left: string; label: string }>, dots: [] as Array<{ left: string; ms: MilestoneValue; date: Date }>, todayLeft: '' };
  const lo = [today, ...dated.map((d) => d.date)].reduce((a, b) => (a < b ? a : b));
  const hi = dated.map((d) => d.date).reduce((a, b) => (a > b ? a : b));
  const loEdge = addD(lo, -10);
  const hiEdge = addD(hi, 14);
  const span = Math.max(1, diffD(loEdge, hiEdge));
  const pct = (d: Date) => `${(diffD(loEdge, d) / span) * 100}%`;
  const ticks: Array<{ left: string; label: string }> = [];
  for (
    let d = new Date(loEdge.getFullYear(), loEdge.getMonth() + 1, 1);
    d < hiEdge;
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1)
  ) {
    ticks.push({
      left: pct(d),
      label:
        d.getMonth() === 0
          ? `1月 '${String(d.getFullYear()).slice(2)}`
          : `${d.getMonth() + 1}月`,
    });
  }
  const visible = new Set(options.value.map((o) => o.ms.key));
  return {
    ticks,
    todayLeft: pct(today),
    dots: dated
      .filter((d) => visible.has(d.ms.key))
      .map((d) => ({ left: pct(d.date), ms: d.ms, date: d.date })),
  };
}

const tl = computed(timeline);

/* ---------- 定位 / 打开关闭 ---------- */
function place() {
  const pop = popEl.value;
  if (!pop || !props.triggerEl) return;
  const r = props.triggerEl.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 412))}px`;
}

function onResize() {
  if (popEl.value) place();
}

function onOutsidePointerDown(ev: PointerEvent) {
  const target = ev.target as HTMLElement | null;
  if (
    target?.closest('.ms-pop, .ms-trigger, .ms-tokens .more')
  ) {
    return;
  }
  emit('close');
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    ev.stopPropagation();
    emit('close', true);
  }
}

function onSearchKeydown(ev: KeyboardEvent) {
  const els = optElements();
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!els.length) return;
    kbIndex.value =
      (kbIndex.value + (ev.key === 'ArrowDown' ? 1 : -1) + els.length) %
      els.length;
    els.forEach((el, i) => el.classList.toggle('kb', i === kbIndex.value));
    els[kbIndex.value].scrollIntoView({ block: 'nearest' });
    setHot(els[kbIndex.value].dataset.k || null);
  } else if (ev.key === 'Enter' && kbIndex.value >= 0 && els[kbIndex.value]) {
    ev.preventDefault();
    toggle(els[kbIndex.value].dataset.k || '');
  }
}

function onOptionClick(key: string) {
  kbIndex.value = options.value.findIndex((o) => o.ms.key === key);
  toggle(key);
}

function refreshDict() {
  void state.syncMilestoneDictionary({ force: true });
}

function updatedAgo(): string {
  const ms = state.msDictUpdatedAt.value;
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h 前`;
  return `${Math.floor(hours / 24)}d 前`;
}

watch(search, () => {
  kbIndex.value = -1;
});

onMounted(() => {
  place();
  window.addEventListener('resize', onResize);
  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
  requestAnimationFrame(() => {
    shown.value = true;
    searchEl.value?.focus();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
});

// 打开浮层时：补拉字典里还没有的新 key；整体超过 6 小时则后台全量刷新
// （stale-while-revalidate 兜底）
void state.syncMilestoneDictionary({
  force: state.msDictStale.value,
});
</script>

<template>
  <div ref="popEl" class="ms-pop" :class="{ show: shown }" role="dialog" aria-label="按 Milestone 过滤">
    <div class="ms-pop-head">
      <div class="ms-src">
        <span class="ms-dia" aria-hidden="true" />
        {{ sourceLine().label }}
        <a
          v-if="sourceLine().url"
          :href="sourceLine().url"
          target="_blank"
          rel="noopener"
          >{{ esc(state.milestones.value[0]?.labelName || '') }}</a
        >
      </div>
      <input
        ref="searchEl"
        v-model="search"
        class="ms-search"
        type="search"
        placeholder="搜索 milestone 名称 / Key / 描述…"
        spellcheck="false"
        role="combobox"
        aria-expanded="true"
        aria-controls="msList"
        aria-autocomplete="list"
        @keydown="onSearchKeydown"
      />
      <div class="ms-tl" aria-hidden="true">
        <div class="ms-tl-axis" />
        <span
          v-for="(t, i) in tl.ticks"
          :key="`t-${i}`"
          class="ms-tl-tick"
          :style="{ left: t.left }"
          >{{ t.label }}</span
        >
        <span class="ms-tl-today" :style="{ left: tl.todayLeft }" />
        <span
          v-for="d in tl.dots"
          :key="`d-${d.ms.key}`"
          class="ms-tl-dot"
          :class="{
            sel: state.msSel.value.includes(d.ms.key),
            past: d.date < today,
          }"
          :data-k="d.ms.key"
          :style="{ left: d.left }"
        />
      </div>
    </div>
    <div class="ms-list" role="listbox" aria-multiselectable="true">
      <template v-if="options.length">
        <template v-for="sec in sections" :key="sec.label || 'default'">
          <div v-if="sec.showHeader" class="ms-sec">{{ sec.label }}</div>
          <button
            v-for="opt in sec.options"
            :key="opt.ms.key"
            type="button"
            class="ms-opt"
            :class="{ zero: !opt.count, past: opt.date ? opt.date < today : false }"
            role="option"
            :aria-selected="state.msSel.value.includes(opt.ms.key)"
            :data-k="opt.ms.key"
            @mouseenter="setHot(opt.ms.key)"
            @focus="setHot(opt.ms.key)"
            @click="onOptionClick(opt.ms.key)"
          >
            <span class="box">
              <svg width="10" height="10" viewBox="0 0 12 12">
                <path
                  d="M2.5 6.2l2.4 2.4 4.6-5"
                  fill="none"
                  stroke="#fff"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <span style="min-width: 0">
              <div class="nm">{{ opt.ms.name }}</div>
              <div class="sub">
                <span class="src">{{ opt.ms.key }}</span>
                <span>{{ opt.count }} 个条目</span>
              </div>
            </span>
            <span class="rt">
              <div v-if="opt.date" class="dt">{{ fmtMD(opt.date) }}</div>
              <div v-else class="dt unk">日期未知</div>
              <div v-if="opt.date" class="rel">{{ relText(opt.date) }}</div>
              <div v-else class="rel">见描述</div>
            </span>
          </button>
        </template>
      </template>
      <div v-else class="ms-none">
        没有匹配「{{ search.trim() }}」的 milestone
      </div>
    </div>
    <div class="ms-detail">
      <div class="dk">
        {{ detailHtml.key }}
        <span v-if="detailHtml.tag" class="tag" :class="{ warn: detailHtml.tagWarn }">{{
          detailHtml.tag
        }}</span>
      </div>
      <div class="ds" :style="detailHtml.muted ? 'color:var(--muted)' : ''" v-html="detailHtml.body" />
    </div>
    <div class="ms-foot">
      <span class="hint">
        多选 = 命中任一 · <kbd>↑</kbd><kbd>↓</kbd> 移动 <kbd>Enter</kbd> 勾选
        <kbd>Esc</kbd> 关闭
      </span>
      <span class="upd">{{ updatedAgo() }}<template v-if="updatedAgo()"> · </template></span>
      <button
        type="button"
        class="refr"
        :class="{ spin: state.msDictSyncing.value }"
        :disabled="state.msDictSyncing.value || !state.hasExtension.value"
        data-tip="经扩展从 Jira 强制刷新 milestone 名称 / 描述 / 日期"
        @click="refreshDict"
      >
        ↻
      </button>
      <button
        type="button"
        class="clr"
        :disabled="!state.msSel.value.length"
        @click="state.setMsSel([])"
      >
        清除
      </button>
      <button type="button" class="btn btn-primary done" @click="emit('close', true)">
        完成
      </button>
    </div>
  </div>
</template>
