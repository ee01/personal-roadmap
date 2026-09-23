<script setup lang="ts">
import { useRoadmapState } from '../composables/useRoadmapState';

const state = useRoadmapState();
</script>

<template>
  <div class="toast-wrap">
    <div
      v-for="t in state.toasts.value"
      :key="t.id"
      class="toast"
      v-html="t.html"
    />
  </div>
</template>
