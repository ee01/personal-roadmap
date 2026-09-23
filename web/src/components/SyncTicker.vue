<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  pickTickerEntry,
  tickerLabel,
} from '../composables/useRoadmapContract';
import { useRoadmapState } from '../composables/useRoadmapState';
import { dispName, teamAssigneeMap } from '../composables/useAssigneeMap';

const state = useRoadmapState();
const assigneeMap = computed(() => teamAssigneeMap(state.snapshot.value));

const entry = computed(() =>
  pickTickerEntry(
    state.visibleActivity.value,
    state.api.clientId.value,
    state.teamId.value,
  ),
);

const visible = computed(() => Boolean(entry.value));

interface Line {
  id: string;
  time: string;
  who: string;
  label: string;
  anim: '' | 'in' | 'out';
}

const lines = ref<Line[]>([]);
const flash = ref(false);
let firstPaint = true;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function fmtHM(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function openActivity() {
  state.activityOpen.value = true;
  if (state.teamId.value) {
    state.api.fetchActivity(state.teamId.value).then((items) => {
      state.activity.value = items;
    });
  }
}

watch(
  () => entry.value?.id ?? null,
  async (id, prevId) => {
    const next = entry.value;
    if (!next || !id) {
      lines.value = [];
      firstPaint = true;
      return;
    }
    if (id === prevId) return;

    const incoming: Line = {
      id: next.id,
      time: fmtHM(next.at),
      who: dispName(assigneeMap.value, next.actorName),
      label: tickerLabel(next),
      anim: firstPaint ? '' : 'in',
    };

    if (firstPaint) {
      lines.value = [incoming];
      firstPaint = false;
      return;
    }

    const current = lines.value.find((l) => l.anim !== 'out');
    if (current) {
      current.anim = 'out';
      const dyingId = current.id;
      setTimeout(() => {
        lines.value = lines.value.filter((l) => l.id !== dyingId);
      }, 520);
    }

    lines.value = [...lines.value.filter((l) => l.anim === 'out'), incoming];

    flash.value = false;
    await nextTick();
    flash.value = true;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash.value = false;
    }, 1200);
  },
  { immediate: true },
);

watch(
  () => state.teamId.value,
  () => {
    firstPaint = true;
    lines.value = [];
  },
);
</script>

<template>
  <div
    v-show="visible"
    class="sync-ticker"
    :class="{ on: visible, flash }"
    data-tip="协作同步||仅展示当前团队其他成员的最新一条编辑；点击打开该团队的活动日志"
    @click="openActivity"
  >
    <div
      v-for="line in lines"
      :key="line.id"
      class="st-line"
      :class="line.anim"
    >
      <span class="st-time">{{ line.time }}</span>
      <span class="st-text">
        <b>{{ line.who }}</b>
        {{ line.label }}
      </span>
    </div>
  </div>
</template>
