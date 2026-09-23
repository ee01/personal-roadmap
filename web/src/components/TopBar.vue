<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoadmapState } from '../composables/useRoadmapState';
import { copyTextToClipboard, esc, initials } from '../composables/useGeometry';
import { dispName, teamAssigneeMap } from '../composables/useAssigneeMap';
import SyncTicker from './SyncTicker.vue';

const state = useRoadmapState();
const teamOpen = ref(false);
const assigneeMap = computed(() => teamAssigneeMap(state.snapshot.value));
function showName(name: string) {
  return dispName(assigneeMap.value, name);
}

function isReadonlyTeam(id: string) {
  return !state.api.getShareToken(id);
}

function switchTeam(id: string) {
  teamOpen.value = false;
  state.selectTeam(id);
}

function openNewTeam() {
  teamOpen.value = false;
  state.modals.value.team = true;
}

function shareAuthErrorMessage(error: unknown): string {
  const status = Number((error as { status?: number })?.status || 0);
  const code = String((error as { body?: { error?: string } })?.body?.error || '');
  if (status === 403 || /share token|edit/i.test(code)) {
    return '分享失败：当前没有有效的编辑权限（需要 edit token）';
  }
  if (status === 404 || code === 'team_not_found') {
    return '分享失败：团队不存在';
  }
  return `分享失败：${code || '请求出错'}（${status || '网络错误'}）`;
}

async function shareLink() {
  if (!state.ensureActorName() || !state.editable.value) return;

  let url = '';
  try {
    // Keep expand/q/view in the address bar so the shared link mirrors this view.
    state.syncUrl();
    const token = await state.api.shareTeam(state.teamId.value);
    const p = new URLSearchParams(location.search);
    p.set('team', state.teamId.value);
    p.set('token', token);
    url = `${location.origin}${location.pathname}?${p.toString()}`;
  } catch (error) {
    state.toast(shareAuthErrorMessage(error));
    return;
  }

  const copied = await copyTextToClipboard(url);
  if (copied) {
    state.toast('<span class="ok">✓</span> 可编辑链接已复制到剪贴板');
    return;
  }

  // Clipboard unavailable (common on plain HTTP). Keep the link visible long
  // enough to select, and also surface it via prompt for one-click select.
  state.toast(
    `无法自动复制（当前页非安全上下文）。请手动复制：<br/><code style="user-select:all;word-break:break-all;font-size:11px">${esc(url)}</code>`,
    12000,
  );
  window.prompt('无法自动复制，请手动复制下面的可编辑链接：', url);
}

function toggleActivity() {
  state.activityOpen.value = !state.activityOpen.value;
  if (state.activityOpen.value && state.teamId.value) {
    state.api.fetchActivity(state.teamId.value).then((items) => {
      state.activity.value = items;
    });
  }
}

document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.team-switch')) teamOpen.value = false;
});
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" />
      Personal Roadmap
    </div>

    <div class="team-switch" :class="{ open: teamOpen }">
      <button class="team-btn" @click.stop="teamOpen = !teamOpen">
        <span>{{ state.snapshot.value?.team.name || '—' }}</span>
        <svg class="car" width="11" height="11" viewBox="0 0 12 12">
          <path
            d="M2 4l4 4 4-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <div class="team-menu">
        <button
          v-for="t in state.teams.value"
          :key="t.id"
          :data-tip="isReadonlyTeam(t.id) ? '只读：本机没有该团队的编辑权限' : undefined"
          @click="switchTeam(t.id)"
        >
          <span class="tick">{{ t.id === state.teamId.value ? '✓' : '' }}</span>
          <span class="team-label">{{ t.name }}</span>
          <svg
            v-if="isReadonlyTeam(t.id)"
            class="team-eye"
            viewBox="0 0 16 16"
            aria-label="只读"
          >
            <path
              d="M1.5 8s2.6-4.5 6.5-4.5S14.5 8 14.5 8s-2.6 4.5-6.5 4.5S1.5 8 1.5 8z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
            <circle
              cx="8"
              cy="8"
              r="2.1"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
          </svg>
        </button>
        <div class="divider" />
        <button class="new-team" @click="openNewTeam">
          <span class="tick">＋</span>新建团队…
        </button>
      </div>
    </div>

    <div
      class="jql-pill"
      :data-tip="`数据源 JQL||${state.snapshot.value?.team.jql || ''}`"
    >
      {{ state.snapshot.value?.team.jql || '—' }}
    </div>
    <button
      class="jql-edit"
      data-tip="编辑团队 JQL"
      :disabled="!state.editable.value"
      @click="state.modals.value.jql = true"
    >
      <svg viewBox="0 0 14 14">
        <path
          d="M9.5 2.2l2.3 2.3L4.6 11.7l-2.9.6.6-2.9L9.5 2.2z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <div class="top-spacer" />

    <SyncTicker />

    <div class="presence">
      <span
        v-for="p in (state.snapshot.value?.presence || []).slice(0, 5)"
        :key="p.clientId"
        class="avatar"
        :data-tip="showName(p.name) + (p.clientId === state.api.clientId.value ? '（你）' : '')"
        :style="{
          background:
            state.snapshot.value?.members.find((m) => m.name === p.name)
              ?.avatarColor || '#8895A5',
        }"
      >
        {{ initials(p.name) }}
      </span>
      <span
        class="live-pill"
        data-tip="在线协作成员：草稿任务与拖动实时同步给所有人"
      >
        <span class="live-dot" />
        LIVE
      </span>
    </div>

    <span v-if="!state.editable.value" class="readonly-tag">只读</span>

    <div class="top-actions">
      <button
        class="icon-btn"
        data-tip="分享可编辑链接"
        :disabled="!state.snapshot.value"
        @click="shareLink"
      >
        <svg width="14" height="14" viewBox="0 0 14 14">
          <path
            d="M5 8.5L9 4.5M9 4.5H6.5M9 4.5V7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
          <path
            d="M3.5 5.5V10a1 1 0 001 1H10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        class="icon-btn"
        data-tip="活动日志"
        :disabled="!state.snapshot.value"
        @click="toggleActivity"
      >
        <svg width="14" height="14" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M7 4.5V7.5L9 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </header>
</template>
