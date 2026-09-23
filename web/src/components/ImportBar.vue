<script setup lang="ts">
import { computed } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import {
  chipList,
  CURQ,
  jqlHasTargetDeliveryQuarter,
  qCmp,
} from '../composables/useGeometry';
import { extensionLockTip, useExtensionGate } from '../composables/useExtensionGate';

const state = useRoadmapState();
const gate = useExtensionGate();
const overwrite = state.importOverwrite;

const team = computed(() => state.snapshot.value?.team);
const hasQuarterField = computed(() =>
  jqlHasTargetDeliveryQuarter(team.value?.jql || ''),
);
const chips = computed(() => chipList(team.value?.checkedQuarters || [CURQ]));

const pending = computed(() =>
  state.pendingImportQuarters(
    team.value?.checkedQuarters || [],
    team.value?.importedQuarters || [],
  ),
);

const showImportBtn = computed(() => {
  if (!hasQuarterField.value) return Boolean(team.value?.jql?.trim());
  if (!team.value?.checkedQuarters.length) return false;
  return pending.value.length > 0 || overwrite.value;
});

async function toggleQuarter(q: string) {
  if (!team.value || !state.editable.value) return;
  const checked = [...team.value.checkedQuarters];
  const on = checked.includes(q);
  const next = on ? checked.filter((x) => x !== q) : [...checked, q].sort(qCmp);
  await state.applySnapshotFromIntent({
    op: 'set_quarters',
    checkedQuarters: next,
  });
}

function openImport() {
  if (!state.hasExtension.value) {
    gate.openGate('import');
    return;
  }
  if (!state.ensureActorName()) return;
  state.modals.value.import = true;
}
</script>

<template>
  <div class="import-bar">
    <template v-if="hasQuarterField">
      <span class="ib-label">QUARTERS</span>
      <div class="chips">
        <button
          v-for="q in chips"
          :key="q"
          class="chip"
          :class="{
            on: team?.checkedQuarters.includes(q),
            ghost:
              (team?.checkedQuarters.length
                ? qCmp(q, team.checkedQuarters.reduce((a, b) => (qCmp(a, b) > 0 ? a : b)))
                : q !== CURQ) > 0 && !team?.checkedQuarters.includes(q),
          }"
          :disabled="!state.editable.value"
          @click="toggleQuarter(q)"
        >
          <span class="box">
            <svg width="9" height="9" viewBox="0 0 10 10">
              <path
                d="M1.5 5.5L4 8l4.5-6"
                fill="none"
                stroke="#fff"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          {{ q }}
          <span v-if="q === CURQ" class="now-tag">当前</span>
        </button>
      </div>
    </template>
    <div
      v-if="
        (hasQuarterField && team?.checkedQuarters.length) ||
        (!hasQuarterField && showImportBtn)
      "
      class="import-actions"
    >
      <label class="ow-label">
        <input v-model="overwrite" type="checkbox" :disabled="!state.editable.value" />
        覆盖已有数据
      </label>
      <button
        v-show="showImportBtn"
        class="btn btn-primary"
        :class="{ locked: !state.hasExtension.value }"
        :disabled="!state.editable.value"
        :data-tip="!state.hasExtension.value ? extensionLockTip('import') : undefined"
        @click="openImport"
      >
        <svg class="ico" width="13" height="13" viewBox="0 0 14 14">
          <path
            d="M7 1v8M3.5 6L7 9.5 10.5 6M2 12.5h10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg class="lock" width="12" height="13" viewBox="0 0 14 15">
          <rect
            x="2.4"
            y="6.2"
            width="9.2"
            height="7"
            rx="2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path
            d="M4.7 6.2V4.4a2.3 2.3 0 014.6 0v1.8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        导入 Backlog
      </button>
    </div>
  </div>
</template>
