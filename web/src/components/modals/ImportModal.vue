<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoadmapState } from '../../composables/useRoadmapState';
import {
  effectiveJqlHtml,
  jqlHasTargetDeliveryQuarter,
} from '../../composables/useGeometry';
import { bridgeImportJql } from '../../composables/useExtensionBridge';
import {
  extensionLockTip,
  useExtensionGate,
} from '../../composables/useExtensionGate';

const state = useRoadmapState();
const gate = useExtensionGate();
const loading = ref(false);
// 覆盖开关在导入栏已经勾过，这里只跟随它预览，不再要求二次确认
const overwrite = state.importOverwrite;

const team = computed(() => state.snapshot.value?.team);
const hasQuarterField = computed(() =>
  jqlHasTargetDeliveryQuarter(team.value?.jql || ''),
);

const importQs = computed(() => {
  if (!team.value || !hasQuarterField.value) return [] as string[];
  const pending = state.pendingImportQuarters(
    team.value.checkedQuarters,
    team.value.importedQuarters,
  );
  return overwrite.value ? team.value.checkedQuarters : pending;
});

const previewHtml = computed(() =>
  team.value ? effectiveJqlHtml(team.value.jql, importQs.value) : '',
);

watch(
  () => state.modals.value.import,
  () => {
    loading.value = false;
  },
);

async function runImport() {
  if (!team.value) return;
  if (hasQuarterField.value && !importQs.value.length) return;
  if (!state.hasExtension.value) {
    gate.openGate('import');
    return;
  }
  loading.value = true;
  try {
    const items = await bridgeImportJql(team.value.jql, importQs.value);
    if (!items.length) {
      state.toast(
        hasQuarterField.value
          ? 'Jira 未返回任何 issue，请检查 JQL / Quarter / Token'
          : 'Jira 未返回任何 issue，请检查 JQL / Token',
      );
      return;
    }
    await state.applySnapshotFromIntent({
      op: 'import',
      quarters: importQs.value,
      overwrite: overwrite.value,
      checkedQuarters: team.value.checkedQuarters,
      items,
    });
    state.modals.value.import = false;
    state.toast(`<span class="ok">✓</span> 已导入 <b>${items.length}</b> 个 issue → Backlog`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '导入失败';
    state.toast(`导入失败：${message}`);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div
    class="modal-back"
    :class="{ show: state.modals.value.import }"
    @click.self="state.modals.value.import = false"
  >
    <div class="modal">
      <div class="m-head">
        <div class="m-title">导入预览</div>
        <div class="m-sub">
          <template v-if="!hasQuarterField">
            {{
              overwrite
                ? '覆盖模式：将按当前 JQL 重新拉取，清除 JQL 结果中已不存在的 Jira 导入数据；已排期到 Gantt 的条目及其子任务始终保留。'
                : '增量模式：按当前 JQL 拉取，已存在的 issue 不受影响。'
            }}
          </template>
          <template v-else>
            {{
              overwrite
                ? '覆盖模式：以下 quarters 中 JQL 结果已不存在的数据将被清除；已排期到 Gantt 的条目及其子任务始终保留。'
                : '增量模式：仅导入尚未导入的 quarters，已存在的 issue 不受影响。'
            }}
          </template>
        </div>
      </div>
      <div class="m-body">
        <div v-if="loading" class="imp-loading">
          <div class="spinner" />
          <div>正在执行 JQL 查询 Jira…</div>
        </div>
        <template v-else>
          <template v-if="hasQuarterField">
            <label class="f-label">导入 Quarters</label>
            <div class="q-tags">
              <span v-for="q in importQs" :key="q" class="q-tag">{{ q }}</span>
            </div>
            <label class="f-label">实际执行的 JQL（quarter 子句已替换）</label>
          </template>
          <label v-else class="f-label">实际执行的 JQL</label>
          <div class="jql-preview" v-html="previewHtml" />
        </template>
      </div>
      <div v-if="!loading" class="m-foot">
        <button class="btn btn-ghost" @click="state.modals.value.import = false">取消</button>
        <button
          class="btn btn-primary"
          :class="{ locked: !state.hasExtension.value }"
          :disabled="!state.editable.value"
          :data-tip="!state.hasExtension.value ? extensionLockTip('import') : undefined"
          @click="runImport"
        >
          确认导入
        </button>
      </div>
    </div>
  </div>
</template>
