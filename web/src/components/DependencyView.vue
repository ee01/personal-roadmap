<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import {
  addD,
  DAY_W,
  fmtISO,
  fmtMD,
  X,
  type Timeline,
} from '../composables/useGeometry';
import {
  dependencyGroups,
  dependencyMatches,
  dependencyState,
  dependencyTiming,
  DEP_LABEL,
  type DependencyFilter,
} from '../composables/dependency';
import { bridgeFetchDependencyDates } from '../composables/useExtensionBridge';
import {
  openDepPopover,
  refreshDependencyEta,
  nudgeDependency,
  type MarkerHandlers,
} from '../composables/useMarkerFloats';
import { jiraBrowseUrl } from '../composables/useRoadmapContract';
import type { RoadmapItem, RoadmapMarker } from '../types';
import DependencyTrack from './DependencyTrack.vue';
const props = defineProps<{ tl: Timeline }>();
const state = useRoadmapState();
const root = ref<HTMLElement>();
const items = computed(() =>
  state.scheduledItems.value.filter(state.viewMatch),
);
const groups = computed(() =>
  dependencyGroups(items.value, state.dependencyFilter.value),
);
const filters: Array<[DependencyFilter, string]> = [
  ['all', '全部'],
  ['late', '晚于期望'],
  ['missing', '缺 ETA'],
  ['drift', 'Jira 有变更'],
];
const all = computed(() =>
  items.value.flatMap((i) => i.markers.filter((m) => m.kind === 'dep')),
);
const count = (filter: DependencyFilter) =>
  all.value.filter((m) => dependencyMatches(m, filter)).length;
const ticks = computed(() => {
  const out: string[] = [];
  for (let day = props.tl.start; day <= props.tl.end; day = addD(day, 7))
    out.push(fmtISO(day));
  return out;
});
const width = computed(() => X(props.tl, props.tl.end) + DAY_W.value);
const handlers = computed<MarkerHandlers>(() => ({
  editable: state.editable.value,
  hasExtension: state.hasExtension.value,
  toast: (html) => state.toast(html),
  addMarker: (intent) =>
    state.applySnapshotFromIntent(intent).then(() => undefined),
  updateMarker: (intent) =>
    state.applySnapshotFromIntent(intent).then(() => undefined),
  deleteMarker: (intent) =>
    state.applySnapshotFromIntent(intent).then(() => undefined),
  fetchIssueDates: state.hasExtension.value
    ? bridgeFetchDependencyDates
    : undefined,
  jiraBaseUrl: state.snapshot.value?.team.jiraBaseUrl || '',
  showDependency: (id) => {
    state.dependencyFilter.value = 'all';
    state.dependencyFocus.value = id;
    void focus();
  },
}));
function edit(e: Event, item: RoadmapItem, dep: RoadmapMarker) {
  openDepPopover(e.currentTarget as HTMLElement, item, handlers.value, dep.id);
}
async function focus() {
  await nextTick();
  const id = state.dependencyFocus.value;
  if (!id) return;
  const row = Array.from(
    root.value?.querySelectorAll<HTMLElement>('[data-dependency-row]') || [],
  ).find((el) => el.dataset.dependencyRow === id);
  row?.scrollIntoView({ block: 'center', inline: 'nearest' });
  // Scroll to the dependency date as well as its row.
  const dep = all.value.find((m) => m.id === id);
  if (root.value && dep && (dep.need || dep.date))
    root.value.scrollLeft = Math.max(
      0,
      X(props.tl, (dep.need || dep.date)!) - 120,
    );
}
onMounted(focus);
watch(() => state.dependencyFocus.value, focus);
</script>
<template>
  <div class="dependency-tools">
    <div class="view-switch">
      <button
        v-for="[key, label] in filters"
        :key="key"
        class="vs-btn"
        :class="{ active: state.dependencyFilter.value === key }"
        @click="state.dependencyFilter.value = key"
      >
        {{ label }} <small>{{ count(key) }}</small>
      </button>
    </div>
    <span>● 对方 ETA　◌ 我们期望　▧ Ticket Target Start → End</span>
    <span>拖动改期望 · 单击改 ETA</span>
  </div>
  <div ref="root" class="dependency-scroll">
    <div class="dependency-board" :style="{ width: `${360 + width}px` }">
      <div class="dependency-header">
        <div class="dependency-label">外部依赖 · 按风险排序</div>
        <div class="dependency-axis" :style="{ width: `${width}px` }">
          <span
            v-for="date in ticks"
            :key="date"
            :style="{ left: `${X(tl, date)}px` }"
            >{{ fmtMD(date) }}</span
          >
        </div>
      </div>
      <template v-for="group in groups" :key="group.item.key">
        <div class="dependency-group">
          <div class="dependency-label">
            <b>{{ group.item.alias || group.item.title }}</b
            ><small>{{ group.deps.length }} 个依赖</small>
          </div>
          <div class="dependency-axis">
            <div
              v-if="group.item.start"
              class="dependency-taskbar"
              :style="{
                left: `${X(tl, group.item.start)}px`,
                width: `${(group.item.days || 1) * DAY_W}px`,
              }"
            >
              {{ fmtMD(group.item.start) }} →
              {{ fmtMD(addD(group.item.start, (group.item.days || 1) - 1)) }}
            </div>
          </div>
        </div>
        <div
          v-for="dep in group.deps"
          :key="dep.id"
          class="dependency-row"
          :class="{ focused: state.dependencyFocus.value === dep.id }"
          :data-dependency-row="dep.id"
        >
          <div class="dependency-label">
            <div>
              <span class="dependency-pill" :class="dependencyState(dep)">{{
                DEP_LABEL[dependencyState(dep)]
              }}</span
              ><button
                class="dependency-title"
                @click="edit($event, group.item, dep)"
              >
                {{ dep.label }}
              </button>
            </div>
            <div class="dependency-meta">
              <a
                v-if="dep.jiraKey"
                :href="jiraBrowseUrl(dep.jiraKey, handlers.jiraBaseUrl)"
                target="_blank"
                rel="noopener"
                >{{ dep.jiraKey }}</a
              ><span v-else>手动</span><span>{{ dep.jiraStatus || '' }}</span
              ><span>{{ dependencyTiming(dep) }}</span>
            </div>
            <div class="dependency-meta">
              期望 {{ dep.need || dep.date || '未设置' }} · ETA
              {{ dep.date || '未确认' }}
            </div>
            <div class="dependency-actions">
              <button
                v-if="dep.jiraKey && state.editable.value"
                @click="refreshDependencyEta(group.item, dep, handlers)"
              >
                刷新 ETA</button
              ><button @click="edit($event, group.item, dep)">
                {{ state.editable.value ? '编辑' : '查看依赖' }}</button
              ><button
                v-if="dep.jiraKey"
                @click="nudgeDependency(dep, handlers)"
              >
                催一下</button
              ><button
                v-if="dep.date && dep.need && state.editable.value"
                @click="
                  handlers
                    .updateMarker({
                      op: 'update_marker',
                      markerId: dep.id,
                      need: null,
                      baseVersion: dep.version,
                    })
                    .catch(() => undefined)
                "
              >
                接受 ETA
              </button>
            </div>
          </div>
          <div
            class="dependency-axis"
            :style="{ backgroundSize: `${7 * DAY_W}px 100%` }"
          >
            <DependencyTrack
              :marker="dep"
              :item="group.item"
              :tl="tl"
              :handlers="handlers"
              full
            />
          </div>
        </div>
      </template>
      <div v-if="!groups.length" class="dependency-empty">
        {{
          all.length
            ? '当前筛选下没有依赖'
            : '当前任务没有外部依赖，在甘特任务条上添加依赖后会显示在这里。'
        }}
      </div>
    </div>
  </div>
</template>
<style>
.dependency-tools {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line2);
  font-size: 11px;
  color: var(--muted);
}
.dependency-scroll {
  overflow: auto;
  max-height: calc(100vh - 270px);
  min-height: 240px;
  flex: 1;
}
.dependency-board {
  min-width: 100%;
  font-size: 12px;
}
.dependency-header,
.dependency-group,
.dependency-row {
  display: flex;
  border-bottom: 1px solid var(--line2);
}
.dependency-header {
  position: sticky;
  top: 0;
  z-index: 8;
  background: var(--bg, #f6f7f9);
  height: 34px;
}
.dependency-label {
  position: sticky;
  left: 0;
  width: 360px;
  min-width: 360px;
  box-sizing: border-box;
  background: var(--surface, #fff);
  border-right: 1px solid var(--line2);
  padding: 10px 14px;
  z-index: 4;
}
.dependency-label > div {
  display: flex;
  align-items: center;
  gap: 7px;
}
.dependency-label b {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dependency-label small {
  color: var(--muted);
}
.dependency-axis {
  position: relative;
  flex: 1;
  min-width: 0;
  background-image: linear-gradient(
    to right,
    var(--line2) 1px,
    transparent 1px
  );
}
.dependency-header .dependency-axis span {
  position: absolute;
  top: 10px;
  white-space: nowrap;
  font: 10px var(--mono);
  color: var(--muted);
}
.dependency-group {
  height: 48px;
  background: #7b8da408;
}
.dependency-group .dependency-label {
  background: var(--bg, #f6f7f9);
}
.dependency-taskbar {
  position: absolute;
  top: 14px;
  height: 20px;
  background: #8499b32a;
  border: 1px solid #8499b344;
  border-radius: 4px;
  font: 10px var(--mono);
  white-space: nowrap;
  padding: 2px 6px;
  box-sizing: border-box;
  color: var(--muted);
}
.dependency-row {
  min-height: 114px;
}
.dependency-row.focused {
  box-shadow: inset 0 0 0 2px #c9842a88;
}
.dependency-title {
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
}
.dependency-pill {
  font-size: 9px;
  border-radius: 4px;
  padding: 2px 5px;
  background: #7c879415;
  white-space: nowrap;
  color: var(--muted);
}
.dependency-pill.late,
.dependency-pill.missing {
  color: var(--danger);
  background: #e4573d16;
}
.dependency-pill.drift,
.dependency-pill.stale {
  color: #ad7629;
  background: #c9842a16;
}
.dependency-pill.done {
  color: #458264;
}
.dependency-meta {
  font-size: 10px;
  color: var(--muted);
  margin-top: 5px;
}
.dependency-meta a {
  color: #557fa7;
}
.dependency-actions {
  margin-top: 6px;
}
.dependency-actions button {
  font: 10px inherit;
  font-size: 10px;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 9px 0 0;
}
.dependency-empty {
  padding: 50px 20px;
  color: var(--muted);
}
.dep-need-editor {
  font-size: 10px;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 7px;
  color: var(--muted);
}
.dep-need-editor input {
  width: 112px;
  font-size: 10px;
}
.dep-need-editor button {
  font-size: 10px;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.dep-badge.late {
  background: var(--danger);
  color: white;
}
</style>
