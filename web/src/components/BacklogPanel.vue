<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import {
  buildBacklogGroups,
  canDeleteItem,
  formatEstimate,
  isDraftItem,
  isDoneStatus,
  itemDisplayKey,
  jiraBrowseUrl,
  typeBadge,
  tooltipHintLine,
  DESCRIPTION_MAX_CHARS,
} from '../composables/useRoadmapContract';
import { CURQ, fmtMD, esc } from '../composables/useGeometry';
import type { RoadmapItem } from '../types';
import DraftPlanningModal from './modals/DraftPlanningModal.vue';

const state = useRoadmapState();
const searchQuery = ref('');
const addMode = ref<'manual' | 'ai'>('manual');

const jiraBase = computed(
  () => state.snapshot.value?.team.jiraBaseUrl || 'https://jira.ringcentral.com',
);
function browseUrl(key: string) {
  return jiraBrowseUrl(key, jiraBase.value);
}

function itemMatchesQuery(item: RoadmapItem, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    item.title,
    item.key,
    item.jiraKey || '',
    item.alias || '',
    item.type || '',
    item.quarter || '',
    itemDisplayKey(item),
  ]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}

const filteredBacklog = computed(() =>
  state.backlogItems.value.filter((it) => itemMatchesQuery(it, searchQuery.value)),
);

const groups = computed(() => buildBacklogGroups(filteredBacklog.value));

const imported = computed(
  () => (state.snapshot.value?.team.importedQuarters.length || 0) > 0,
);

const quarterOptions = computed(() => {
  const checked = state.snapshot.value?.team.checkedQuarters || [];
  return checked.includes(CURQ) ? checked : [CURQ, ...checked];
});

const addOpen = ref(false);
const saving = ref(false);
const bodyEl = ref<HTMLElement | null>(null);
const form = ref({
  title: '',
  type: '',
  quarter: CURQ,
  estimate: '' as string,
  targetStart: '',
  targetEnd: '',
  description: '',
});

function openAdd() {
  if (!state.editable.value) return;
  form.value = {
    title: '',
    type: state.jqlHints.value.itemType || '',
    quarter: state.focusQuarter.value || CURQ,
    estimate: '',
    targetStart: '',
    targetEnd: '',
    description: '',
  };
  addOpen.value = true;
  nextTick(() => {
    (document.querySelector('.add-item-modal input') as HTMLInputElement)?.focus();
  });
}

async function submitAdd() {
  const title = form.value.title.trim();
  if (!title || saving.value) return;
  const estimate = Number(form.value.estimate);
  saving.value = true;
  try {
    await state.applySnapshotFromIntent({
      op: 'add_item',
      title,
      type: form.value.type.trim() || undefined,
      quarter: form.value.quarter || undefined,
      estimate: Number.isFinite(estimate) && estimate > 0 ? estimate : undefined,
      targetStart: form.value.targetStart || undefined,
      targetEnd: form.value.targetEnd || undefined,
      description: form.value.description.trim() || undefined,
    });
    addOpen.value = false;
    state.toast(`<span class="ok">✓</span> 已新建条目 <b>${esc(title)}</b>`);
    // 新条目排在列表首位，滚回顶部才看得见
    searchQuery.value = '';
    await nextTick();
    bodyEl.value?.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    /* toast handled centrally */
  } finally {
    saving.value = false;
  }
}

async function removeItem(item: RoadmapItem) {
  if (!state.editable.value || !canDeleteItem(item)) return;
  try {
    await state.applySnapshotFromIntent({ op: 'delete_item', itemKey: item.key });
    state.toast(`已删除条目 ${item.title}`);
  } catch {
    /* toast handled centrally */
  }
}

function cardTipHead(item: RoadmapItem) {
  const bits = [
    itemDisplayKey(item),
    `预估 ${formatEstimate(item.estimate)}`,
    item.targetStart || item.targetEnd ? '' : '无 Target 日期',
    isDoneStatus(item) ? item.status : '',
  ].filter(Boolean);
  return bits.join(' · ');
}

/** Target 只填了一侧也要能显示（缺的一侧用 — 占位，不能让 fmtMD(null) 崩掉整个 Backlog）。 */
function targetLabel(item: RoadmapItem) {
  const from = item.targetStart ? fmtMD(item.targetStart) : '—';
  const to = item.targetEnd ? fmtMD(item.targetEnd) : '—';
  return `Target ${from} → ${to}`;
}

function onCardPointerDown(e: PointerEvent, item: RoadmapItem) {
  if (!state.editable.value) return;
  if ((e.target as HTMLElement).closest('.card-del, .bar-link')) return;
  window.dispatchEvent(
    new CustomEvent('roadmap-card-drag-start', {
      detail: { event: e, item },
    }),
  );
}

function clearSearch() {
  searchQuery.value = '';
}

function onPlanningCommitted() {
  searchQuery.value = '';
  addOpen.value = false;
}

onMounted(() => {
  window.addEventListener('roadmap-planning-committed', onPlanningCommitted);
});
onBeforeUnmount(() => {
  window.removeEventListener('roadmap-planning-committed', onPlanningCommitted);
});
</script>

<template>
  <aside class="backlog">
    <div class="bl-head">
      <div class="bl-title">
        Backlog
        <span class="bl-count">
          <template v-if="searchQuery.trim()">
            {{ filteredBacklog.length }}/{{ state.backlogItems.value.length }}
          </template>
          <template v-else>
            {{ state.backlogItems.value.length }}
          </template>
        </span>
        <button
          v-if="state.editable.value"
          class="bl-add"
          data-tip="手动或使用 AI 批量新建 Backlog 条目（不需要 Jira）"
          @click="openAdd"
        >
          <svg width="11" height="11" viewBox="0 0 14 14">
            <path
              d="M7 2.5v9M2.5 7h9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
          新建条目
        </button>
      </div>
      <div class="bl-search">
        <svg class="bl-search-ico" width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path
            d="M9.2 9.2L12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <input
          v-model="searchQuery"
          class="bl-search-input"
          type="search"
          placeholder="搜索标题 / Key / 备注…"
          spellcheck="false"
          @keydown.esc="clearSearch"
        />
        <button
          v-if="searchQuery"
          class="bl-search-clear"
          type="button"
          data-tip="清空搜索"
          @click="clearSearch"
        >
          ×
        </button>
      </div>
    </div>
    <div ref="bodyEl" class="bl-body">
      <template v-if="filteredBacklog.length">
        <template v-for="[q, items] in groups" :key="q">
          <div class="bl-group-label">{{ q }}</div>
          <div
            v-for="it in items"
            :key="it.key"
            class="card"
            :class="{
              pop: state.popKeys.value.includes(it.key),
              draft: isDraftItem(it) && !isDoneStatus(it),
              done: isDoneStatus(it),
            }"
            :data-tip="`${cardTipHead(it)}||${it.title}||${tooltipHintLine(it.description, `拖到右侧时间轴排期${it.targetStart || it.targetEnd ? '（按 Target 日期落位）' : ''}`)}`"
            :data-pai-item="it.key"
            :data-pai-team="state.teamId.value"
            :data-pai-target-start="it.targetStart || ''"
            :data-pai-target-end="it.targetEnd || ''"
            @pointerdown="onCardPointerDown($event, it)"
          >
            <a
              v-if="it.jiraKey"
              class="bar-link"
              :href="browseUrl(it.jiraKey)"
              target="_blank"
              rel="noopener"
              data-tip="在 Jira 打开"
              @pointerdown.stop
              @click.stop
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 3H3.5A1.5 1.5 0 002 4.5v4A1.5 1.5 0 003.5 10h4A1.5 1.5 0 009 8.5V7M7 2h3v3M5.5 6.5L10 2" />
              </svg>
            </a>
            <div class="card-top">
              <span class="type-badge" :class="typeBadge(it.type).cls">
                {{ typeBadge(it.type).label }}
              </span>
              <span class="card-key">{{ itemDisplayKey(it) }}</span>
              <span v-if="isDraftItem(it)" class="card-draft">DRAFT</span>
              <span class="card-est">{{ formatEstimate(it.estimate) }}</span>
            </div>
            <div class="card-title">{{ isDoneStatus(it) ? '✓ ' : '' }}{{ it.title }}</div>
            <span v-if="it.targetStart || it.targetEnd" class="card-target">
              {{ targetLabel(it) }}
            </span>
            <span
              v-if="it.subs.length"
              class="card-subs"
              :style="{ marginLeft: it.targetStart || it.targetEnd ? '' : '0' }"
            >
              ↺ {{ it.subs.length }} 个子任务记录
            </span>
            <button
              v-if="state.editable.value && canDeleteItem(it)"
              class="card-del"
              data-tip="删除该手动条目"
              @pointerdown.stop
              @click.stop="removeItem(it)"
            >
              ×
            </button>
          </div>
        </template>
      </template>
      <div v-else-if="searchQuery.trim() && state.backlogItems.value.length" class="bl-empty">
        没有匹配「{{ searchQuery.trim() }}」的条目<br />
        <button class="bl-empty-link" type="button" @click="clearSearch">清除搜索</button>
      </div>
      <div v-else class="bl-empty">
        <template v-if="imported">
          Backlog 已清空<br />所有 issue 均已排期 🎉
        </template>
        <template v-else>
          尚未导入数据<br />请在上方勾选 Quarter 后点击<br /><b>「导入」</b>
        </template>
      </div>
    </div>
  </aside>

  <div
    class="modal-back"
    :class="{ show: addOpen }"
    @click.self="!saving && (addOpen = false)"
  >
    <div class="modal add-item-modal" :class="{ 'add-item-ai': addMode === 'ai' }">
      <div class="m-head">
        <div class="m-title">新建 Backlog 条目</div>
        <div class="add-tabs">
          <button
            type="button"
            class="add-tab"
            :class="{ on: addMode === 'manual' }"
            @click="addMode = 'manual'"
          >
            手动创建
          </button>
          <button
            type="button"
            class="add-tab"
            :class="{ on: addMode === 'ai' }"
            @click="addMode = 'ai'"
          >
            使用 AI 批量创建
          </button>
        </div>
        <div class="m-sub">
          <template v-if="addMode === 'manual'">
            手动条目不需要 Jira，排期后会以 DRAFT 状态参与规划；之后可在时间轴上一键创建为 Jira issue。
          </template>
          <template v-else>
            粘贴一段需求，一次生成主任务、子任务和初排甘特，全部保持 Draft。不创建 Jira。
          </template>
        </div>
      </div>
      <div v-if="addMode === 'manual'" class="m-body">
        <label class="f-label">标题 <span class="req">*</span></label>
        <input
          v-model="form.title"
          class="f-input"
          placeholder="例如：Nova 26.4 权限模型重构"
          :disabled="saving"
          @keydown.enter="submitAdd"
          @keydown.esc="addOpen = false"
        />
        <label class="f-label">描述（可选）</label>
        <textarea
          v-model="form.description"
          class="f-input f-desc"
          :maxlength="DESCRIPTION_MAX_CHARS"
          placeholder="背景 / 交付物 / 验收要点。hover 任务条时展示；创建 Jira 时作为 description 的生成依据"
          :disabled="saving"
        />
        <div class="f-grid">
          <div>
            <label class="f-label">类型</label>
            <input
              v-model="form.type"
              class="f-input"
              :placeholder="state.jqlHints.value.itemType || 'Epic'"
              :disabled="saving"
            />
          </div>
          <div>
            <label class="f-label">Quarter</label>
            <select v-model="form.quarter" class="f-input" :disabled="saving">
              <option value="">不指定</option>
              <option v-for="q in quarterOptions" :key="q" :value="q">{{ q }}</option>
            </select>
          </div>
        </div>
        <div class="f-grid">
          <div>
            <label class="f-label">预估（周）</label>
            <input
              v-model="form.estimate"
              class="f-input"
              type="number"
              min="1"
              placeholder="可留空"
              :disabled="saving"
            />
          </div>
          <div>
            <label class="f-label">Target 开始</label>
            <input v-model="form.targetStart" class="f-input" type="date" :disabled="saving" />
          </div>
          <div>
            <label class="f-label">Target 结束</label>
            <input v-model="form.targetEnd" class="f-input" type="date" :disabled="saving" />
          </div>
        </div>
      </div>
      <div v-show="addMode === 'ai'" class="m-body">
        <DraftPlanningModal embedded />
      </div>
      <div v-if="addMode === 'manual'" class="m-foot">
        <button class="btn btn-ghost" :disabled="saving" @click="addOpen = false">取消</button>
        <button
          class="btn btn-primary"
          :disabled="saving || !form.title.trim()"
          @click="submitAdd"
        >
          创建条目
        </button>
      </div>
      <div v-else class="m-foot">
        <button class="btn btn-ghost" @click="addOpen = false">关闭</button>
      </div>
    </div>
  </div>
</template>
