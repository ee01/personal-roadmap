<script setup lang="ts">
import { computed } from 'vue';
import { useRoadmapState } from '../../composables/useRoadmapState';
import { esc } from '../../composables/useGeometry';

const state = useRoadmapState();

const stats = computed(() => state.expiredStats());

async function confirm() {
  const { epics, subs } = stats.value;
  try {
    await state.applySnapshotFromIntent({
      op: 'cleanup',
      itemKeys: epics.map((e) => e.key),
      subIds: subs.map((s) => s.subId),
    });
    state.modals.value.cleanup = false;
    state.popKeys.value = epics.map((e) => e.key);
    state.toast(
      `<span class="ok">✓</span> 已清理：${epics.length} 个 Epic 回退 Backlog，${subs.length} 个过期子任务（可还原）`,
    );
  } catch {
    /* handled */
  }
}
</script>

<template>
  <div
    class="modal-back"
    :class="{ show: state.modals.value.cleanup }"
    @click.self="state.modals.value.cleanup = false"
  >
    <div class="modal">
      <div class="m-head">
        <div class="m-title">清理过期任务</div>
        <div class="m-sub">
          过期 = 结束日期早于今天。<b>Epic 回退 Backlog 并保留子任务记录</b>。
        </div>
      </div>
      <div class="m-body">
        <label class="f-label">将要执行</label>
        <div class="ai-list">
          <div v-for="e in stats.epics" :key="e.key" class="ai-row">
            <span class="epic-ref">{{ e.key }}</span>
            <span class="t">{{ esc(e.alias || e.title) }}</span>
            <span class="st">
              回退 Backlog{{ e.subs.length ? ` · 保留 ${e.subs.length} 条子任务记录` : '' }}
            </span>
          </div>
          <div v-if="stats.subs.length" class="ai-row">
            <span class="epic-ref">子任务</span>
            <span class="t">{{ stats.subs.length }} 个过期子任务将从任务视图清理</span>
            <span class="st">可还原</span>
          </div>
        </div>
      </div>
      <div class="m-foot">
        <button class="btn btn-ghost" @click="state.modals.value.cleanup = false">取消</button>
        <button class="btn btn-primary" :disabled="!state.editable.value" @click="confirm">
          确认清理
        </button>
      </div>
    </div>
  </div>
</template>
