<script setup lang="ts">
import { computed } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import {
  dependencyMatches,
  type DependencyFilter,
} from '../composables/dependency';

/**
 * 依赖视图的过滤（带计数）+ 图例：与「任务 / 人员 / 依赖」切换同一行（见
 * docs/demo/roadmap-demo.html 的 #depTools / #depLegend）。
 */
const state = useRoadmapState();
const FILTERS: Array<[DependencyFilter, string]> = [
  ['all', '全部'],
  ['late', '晚于期望'],
  ['missing', '缺 ETA'],
  ['drift', 'Jira 有变更'],
];
const deps = computed(() =>
  state.scheduledItems.value
    .filter(state.viewMatch)
    .flatMap((i) => (i.markers || []).filter((m) => m.kind === 'dep')),
);
const counts = computed(() =>
  Object.fromEntries(
    FILTERS.map(([f]) => [f, deps.value.filter((m) => dependencyMatches(m, f)).length]),
  ) as Record<DependencyFilter, number>,
);
const tone = (f: DependencyFilter) =>
  !counts.value[f] ? '' : f === 'late' || f === 'missing' ? 'red' : f === 'drift' ? 'amber' : '';
</script>

<template>
  <div class="view-switch dep-tools" role="group" aria-label="依赖过滤">
    <button
      v-for="[f, label] in FILTERS"
      :key="f"
      type="button"
      class="vs-btn"
      :class="{ active: state.dependencyFilter.value === f }"
      :aria-pressed="state.dependencyFilter.value === f"
      @click="state.dependencyFilter.value = f"
    >
      {{ label }}<span class="n" :class="tone(f)">{{ counts[f] }}</span>
    </button>
  </div>
  <div class="legend dep-legend">
    <span class="lg"><i class="g eta" />ETA（对方）</span>
    <span class="lg"><i class="g need" />期望（我们）</span>
    <span class="lg"><i class="g late" />晚于期望</span>
    <span class="lg"><i class="g span" />Ticket 排期</span>
  </div>
</template>
