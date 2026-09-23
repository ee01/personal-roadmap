<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoadmapState } from '../../composables/useRoadmapState';
import {
  collectPeople,
  effectiveFullName,
  jiraUsernameFromFull,
  looksFullName,
  suggestFullNamePeople,
  type AssigneeMap,
} from '../../composables/useAssigneeMap';
import { initials } from '../../composables/useGeometry';

const state = useRoadmapState();
const open = computed(() => state.modals.value.assigneeMap);
const draft = ref<AssigneeMap>({});
const saving = ref(false);
const merging = ref(false);

/** Row currently showing the suggest dropdown (system name lowercase key). */
const suggestFor = ref<string | null>(null);
const suggestQuery = ref('');
const suggestIndex = ref(0);

const people = computed(() =>
  collectPeople({
    currentUser: state.api.actorName.value || '',
    members: state.snapshot.value?.members || [],
    items: state.snapshot.value?.items || [],
  }),
);

const suggestions = computed(() => {
  if (!suggestFor.value) return [];
  const row = people.value.find(
    (p) => p.name.toLowerCase() === suggestFor.value,
  );
  if (!row) return [];
  return suggestFullNamePeople(people.value, suggestQuery.value, row.name);
});

watch(open, (isOpen) => {
  if (!isOpen) {
    closeSuggest();
    return;
  }
  draft.value = { ...(state.snapshot.value?.team.assigneeMap || {}) };
  // Prefill names that already look like Firstname Lastname.
  for (const p of people.value) {
    const key = p.name.toLowerCase();
    if (!draft.value[key] && looksFullName(p.name)) {
      draft.value[key] = p.name.trim();
    }
  }
});

watch(suggestions, (list) => {
  if (suggestIndex.value >= list.length) suggestIndex.value = 0;
});

function sourceLabel(sources: Set<string>): string {
  return [...sources].join(' · ');
}

function previewUser(name: string): string {
  const full = effectiveFullName(draft.value, name);
  return full ? jiraUsernameFromFull(full) : '';
}

function wordHint(name: string): string {
  const val = draft.value[name.toLowerCase()] || '';
  if (!val.trim()) return '';
  return looksFullName(val) ? '' : '需要两个词';
}

function autoFill() {
  const next = { ...draft.value };
  for (const p of people.value) {
    const key = p.name.toLowerCase();
    if (!next[key] && looksFullName(p.name)) next[key] = p.name.trim();
  }
  draft.value = next;
}

function memberColor(name: string): string {
  return (
    state.snapshot.value?.members.find((m) => m.name === name)?.avatarColor ||
    '#8895A5'
  );
}

function closeSuggest() {
  suggestFor.value = null;
  suggestQuery.value = '';
  suggestIndex.value = 0;
}

function openSuggest(name: string, value: string) {
  suggestFor.value = name.toLowerCase();
  suggestQuery.value = value;
  suggestIndex.value = 0;
}

function onInput(name: string, value: string) {
  draft.value = { ...draft.value, [name.toLowerCase()]: value };
  openSuggest(name, value);
}

function onFocus(name: string) {
  const key = name.toLowerCase();
  openSuggest(name, draft.value[key] || '');
}

function onBlur() {
  // Delay so mousedown on a suggestion can fire first.
  window.setTimeout(() => closeSuggest(), 150);
}

function onKeydown(e: KeyboardEvent, name: string) {
  if (suggestFor.value !== name.toLowerCase()) return;
  const list = suggestions.value;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!list.length) return;
    suggestIndex.value = (suggestIndex.value + 1) % list.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!list.length) return;
    suggestIndex.value =
      (suggestIndex.value - 1 + list.length) % list.length;
  } else if (e.key === 'Enter') {
    if (!list.length) return;
    e.preventDefault();
    void pickSuggestion(name, list[suggestIndex.value].name);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSuggest();
  }
}

async function pickSuggestion(fromName: string, toName: string) {
  if (merging.value || !state.editable.value) return;
  if (fromName.toLowerCase() === toName.toLowerCase()) {
    draft.value = { ...draft.value, [fromName.toLowerCase()]: toName };
    closeSuggest();
    return;
  }
  const ok = window.confirm(
    `将「${fromName}」与「${toName}」合并为同一人？\n` +
      `子任务 Owner / 创建者与成员记录会改写为「${toName}」。\n` +
      `短名「${fromName}」会保留为 Assignee 映射别名（本机登录名若相同会一并改名）。`,
  );
  if (!ok) return;

  merging.value = true;
  closeSuggest();
  try {
    await state.applySnapshotFromIntent({
      op: 'merge_people',
      fromName,
      toName,
    });
    // Keep short login name resolving after merge if this browser is the source.
    if (
      state.api.actorName.value.trim().toLowerCase() ===
      fromName.trim().toLowerCase()
    ) {
      state.api.setActorName(toName);
    }
    draft.value = {
      ...(state.snapshot.value?.team.assigneeMap || {}),
    };
    for (const p of people.value) {
      const key = p.name.toLowerCase();
      if (!draft.value[key] && looksFullName(p.name)) {
        draft.value[key] = p.name.trim();
      }
    }
    state.toast(
      `<span class="ok">✓</span> 已合并 ${fromName} → ${toName}`,
    );
    await nextTick();
  } catch (err) {
    state.toast(err instanceof Error ? err.message : '合并失败');
  } finally {
    merging.value = false;
  }
}

async function save() {
  if (saving.value || !state.editable.value) return;
  saving.value = true;
  try {
    const cleaned: AssigneeMap = {};
    for (const [k, v] of Object.entries(draft.value)) {
      const key = k.trim().toLowerCase();
      const val = String(v || '').trim();
      if (key && val) cleaned[key] = val;
    }
    await state.applySnapshotFromIntent({
      op: 'update_assignee_map',
      assigneeMap: cleaned,
    });
    state.modals.value.assigneeMap = false;
    state.toast('<span class="ok">✓</span> Assignee 映射已保存');
  } catch (err) {
    state.toast(err instanceof Error ? err.message : '保存失败');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div
    class="modal-back"
    :class="{ show: open }"
    @click.self="state.modals.value.assigneeMap = false"
  >
    <div class="modal" style="width: 640px">
      <div class="m-head">
        <div class="m-title">Assignee 映射</div>
        <div class="m-sub">
          系统名（成员名 / 创建者用户名）→ Jira 实名
          <b>Firstname Lastname</b>。输入时可从已有实名人员中选择并<strong>合并为同一人</strong>；保存后全团队共享；直连 API 会转成
          <code>firstname.lastname</code> 填 assignee。
        </div>
      </div>
      <div class="m-body" style="max-height: min(60vh, 420px); overflow-y: auto; overflow-x: visible">
        <div class="am-toolbar">
          <button type="button" class="btn btn-ghost" @click="autoFill">
            ✦ 自动填充空缺
          </button>
          <span class="am-hint">两个词以上的系统名会自动推断；选建议项会合并人员</span>
        </div>
        <div
          class="am-list"
          :style="suggestFor ? { paddingBottom: '168px' } : undefined"
        >
          <div v-for="p in people" :key="p.name.toLowerCase()" class="am-row">
            <span class="own-av" :style="{ background: memberColor(p.name) }">
              {{ initials(p.name) }}
            </span>
            <div class="am-name">
              <div class="n">{{ p.name }}</div>
              <div class="am-src">{{ sourceLabel(p.sources) }}</div>
            </div>
            <div class="am-field">
              <input
                class="am-input"
                :value="draft[p.name.toLowerCase()] || ''"
                placeholder="Firstname Lastname"
                autocomplete="off"
                :disabled="merging"
                @focus="onFocus(p.name)"
                @input="
                  onInput(
                    p.name,
                    ($event.target as HTMLInputElement).value,
                  )
                "
                @keydown="onKeydown($event, p.name)"
                @blur="onBlur"
              />
              <div
                v-if="
                  suggestFor === p.name.toLowerCase() && suggestions.length
                "
                class="am-suggest"
                @mousedown.prevent
              >
                <button
                  v-for="(s, i) in suggestions"
                  :key="s.name.toLowerCase()"
                  type="button"
                  class="am-suggest-item"
                  :class="{ active: i === suggestIndex }"
                  @mousedown.prevent="pickSuggestion(p.name, s.name)"
                >
                  <span
                    class="own-av"
                    :style="{ background: memberColor(s.name) }"
                  >{{ initials(s.name) }}</span>
                  <span class="am-suggest-name">{{ s.name }}</span>
                  <span class="am-suggest-hint">合并</span>
                </button>
              </div>
              <div v-if="wordHint(p.name)" class="am-warn">{{ wordHint(p.name) }}</div>
            </div>
            <div class="am-user" :class="{ none: !previewUser(p.name) }">
              {{ previewUser(p.name) || '未映射' }}
            </div>
          </div>
        </div>
      </div>
      <div class="m-foot">
        <button
          type="button"
          class="btn btn-ghost"
          @click="state.modals.value.assigneeMap = false"
        >
          取消
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!state.editable.value || saving || merging"
          @click="save"
        >
          {{ saving ? '保存中…' : '保存映射' }}
        </button>
      </div>
    </div>
  </div>
</template>
