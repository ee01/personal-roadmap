<script setup lang="ts">
import { useRoadmapState } from '../composables/useRoadmapState';
import { isSystemActivity } from '../composables/useRoadmapContract';
import type { ActivityEntry } from '../types';

const state = useRoadmapState();

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function activityBody(item: ActivityEntry) {
  const text = String(item.text || '').trim();
  if (!isSystemActivity(item)) return text;
  const who = String(item.actorName || '系统').trim();
  if (who && text.startsWith(who)) return text.slice(who.length).trimStart();
  return text;
}
</script>

<template>
  <aside class="activity-drawer" :class="{ open: state.activityOpen.value }">
    <div class="ad-head">
      <div class="ad-title">
        活动日志
        <span v-if="state.snapshot.value" class="ad-team">{{
          state.snapshot.value.team.name
        }}</span>
      </div>
      <button class="icon-btn" @click="state.activityOpen.value = false">×</button>
    </div>
    <div class="ad-body">
      <div v-if="!state.visibleActivity.value.length" class="ad-empty">
        暂无活动记录<br />当前团队的导入、排期与协作操作会显示在这里
      </div>
      <div
        v-for="item in state.visibleActivity.value"
        :key="item.id"
        class="ad-item"
        :class="{ system: isSystemActivity(item) }"
      >
        <div class="ad-time">{{ formatTime(item.at) }}</div>
        <div class="ad-who">{{ isSystemActivity(item) ? '系统' : item.actorName }}</div>
        <div>{{ activityBody(item) }}</div>
      </div>
    </div>
  </aside>
</template>
