<script setup lang="ts">
import { watch } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import {
  JIRA_WRITE_SKIPPED_ACTION,
  JIRA_WRITE_SKIPPED_TEXT,
  useExtensionGate,
} from '../composables/useExtensionGate';

const state = useRoadmapState();
const gate = useExtensionGate();

watch(
  () => state.hasExtension.value,
  (installed) => {
    if (installed) gate.hideWriteNotice();
  },
);
</script>

<template>
  <div
    class="jira-write-notice"
    :class="{ show: gate.writeNoticeOpen.value }"
    role="status"
  >
    <span>{{ JIRA_WRITE_SKIPPED_TEXT }}</span>
    <button
      type="button"
      class="jira-write-notice-action"
      @click="gate.openWriteNoticeInstall()"
    >
      {{ JIRA_WRITE_SKIPPED_ACTION }}
    </button>
  </div>
</template>
