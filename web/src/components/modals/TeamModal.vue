<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoadmapState } from '../../composables/useRoadmapState';
import { CURQ, qByOffset } from '../../composables/useGeometry';

const state = useRoadmapState();
const name = ref('');
const jql = ref('');

watch(
  () => state.modals.value.team,
  (open) => {
    if (open) {
      name.value = '';
      jql.value = `issueFunction in portfolioChildrenOf('project = INIT AND Team in ("Nova CA - Brandy") AND "Target Delivery Quarter" in (${qByOffset(0)}, ${qByOffset(1)}) AND status not in (Cancelled)') and issuetype = Epic and status not in (Cancelled, Closed) and project=NOVA and Team in ("Nova CA - Brandy")`;
    }
  },
);

async function create() {
  if (!state.ensureActorName()) return;
  if (!name.value.trim()) return;
  if (!jql.value.trim()) return;
  try {
    const { snapshot } = await state.api.createTeam({
      name: name.value.trim(),
      jql: jql.value.trim(),
      checkedQuarters: [CURQ],
    });
    state.modals.value.team = false;
    await state.loadTeams(snapshot.team.id);
    state.toast(`团队「${name.value.trim()}」已创建`);
  } catch {
    state.toast('创建团队失败');
  }
}
</script>

<template>
  <div class="modal-back" :class="{ show: state.modals.value.team }" @click.self="state.modals.value.team = false">
    <div class="modal">
      <div class="m-head">
        <div class="m-title">新建团队</div>
        <div class="m-sub">
          输入团队名称和数据源 JQL。JQL 中的
          <b style="font-family: var(--mono)">"Target Delivery Quarter" in (...)</b>
          子句会在导入时被替换为你勾选的 quarters。
        </div>
      </div>
      <div class="m-body">
        <label class="f-label">团队名称</label>
        <input v-model="name" class="f-input" placeholder="例如：Nova Brandy" />
        <label class="f-label">数据源 JQL</label>
        <textarea v-model="jql" class="f-input" style="min-height: 140px" />
        <div class="m-sub" style="margin-top: 8px">
          创建后可勾选 Quarter 并导入数据到 Backlog。
        </div>
      </div>
      <div class="m-foot">
        <button class="btn btn-ghost" @click="state.modals.value.team = false">取消</button>
        <button class="btn btn-primary" @click="create">创建</button>
      </div>
    </div>
  </div>
</template>
