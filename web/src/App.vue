<script setup lang="ts">
import { provideRoadmapState } from './composables/useRoadmapState';
import TopBar from './components/TopBar.vue';
import ImportBar from './components/ImportBar.vue';
import BacklogPanel from './components/BacklogPanel.vue';
import GanttPanel from './components/GanttPanel.vue';
import ActivityDrawer from './components/ActivityDrawer.vue';
import HelpFab from './components/HelpFab.vue';
import TooltipLayer from './components/TooltipLayer.vue';
import ToastLayer from './components/ToastLayer.vue';
import JiraWriteNotice from './components/JiraWriteNotice.vue';
import TeamModal from './components/modals/TeamModal.vue';
import JqlModal from './components/modals/JqlModal.vue';
import ImportModal from './components/modals/ImportModal.vue';
import CleanupModal from './components/modals/CleanupModal.vue';
import AiCreateModal from './components/modals/AiCreateModal.vue';
import AssigneeMapModal from './components/modals/AssigneeMapModal.vue';
import NameGateModal from './components/modals/NameGateModal.vue';
import ExtensionGateModal from './components/modals/ExtensionGateModal.vue';

const state = provideRoadmapState();
</script>

<template>
  <div class="app-shell">
    <TopBar />
    <ImportBar />
    <div v-if="state.loading.value" class="loading-screen">加载中…</div>
    <div v-else-if="!state.snapshot.value" class="loading-screen">
      <p>尚无团队</p>
      <button class="btn btn-primary" @click="state.modals.value.team = true">
        新建团队
      </button>
    </div>
    <div v-else class="layout">
      <BacklogPanel />
      <GanttPanel />
    </div>
    <ActivityDrawer />
    <HelpFab />
    <TooltipLayer />
    <JiraWriteNotice />
    <ToastLayer />
    <TeamModal />
    <JqlModal />
    <ImportModal />
    <CleanupModal />
    <AiCreateModal />
    <AssigneeMapModal />
    <NameGateModal />
    <ExtensionGateModal />
  </div>
</template>

<style scoped>
.loading-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--muted);
}
</style>
