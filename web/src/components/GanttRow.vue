<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  X,
  DAY_W,
  colorCls,
  fmtMD,
  fmtISO,
  addD,
  diffD,
  clamp,
  esc,
  initials,
  fitLanes,
  type Timeline,
} from '../composables/useGeometry';
import { memberChipHtml, openOwnerFloat } from '../composables/useOwnerFloat';
import type { RoadmapItem, RoadmapSub, TeamMember } from '../types';
import { useRoadmapState } from '../composables/useRoadmapState';
import { isDraftItem, itemDisplayKey, jiraBrowseUrl, pendingDepCount, driftedDepCount, depBadgeTip, depHoverTip, depEtaMismatchesJira, trackMarkers, phaseColor, phaseGlyph, tooltipHintLine, clampDescription, DESCRIPTION_MAX_CHARS, shouldWrapAlias, isDoneStatus } from '../composables/useRoadmapContract';
import {
  defaultNewSubSpan,
  dispName,
  teamAssigneeMap,
} from '../composables/useAssigneeMap';
import {
  isMarkerDone,
  linkIconHtml,
  markerDragStart,
  openDepPopover,
  openMarkerMenu,
  type MarkerHandlers,
} from '../composables/useMarkerFloats';
import { bridgeFetchIssueDates } from '../composables/useExtensionBridge';
import {
  catchReleaseHint,
  relParsed,
  type ReleaseSheetConfig,
} from '../composables/useReleaseRuler';

const props = defineProps<{
  item: RoadmapItem;
  tl: Timeline;
  teamId: string;
  editable: boolean;
  enter?: boolean;
  newSubId?: string | null;
  /** Persist expand/collapse to local viewer state + URL (not multi-user sync). */
  persistToggle?: (open: boolean) => void | Promise<void>;
  applyMarkerIntent?: (intent: Record<string, unknown>) => Promise<void>;
}>();

const emit = defineEmits<{
  unschedule: [];
  toggleExpand: [open: boolean];
  commit: [payload: { start: string; days: number; lane?: number; op?: string; sub: RoadmapSub | null }];
  setAlias: [intent: Record<string, unknown>];
  addSub: [intent: Record<string, unknown>];
  deleteSub: [intent: Record<string, unknown>];
  updateSub: [intent: Record<string, unknown>];
  addMarker: [intent: Record<string, unknown>];
  updateMarker: [intent: Record<string, unknown>];
  deleteMarker: [intent: Record<string, unknown>];
}>();

const state = useRoadmapState();
const rowRef = ref<HTMLElement | null>(null);
const subsRef = ref<HTMLElement | null>(null);
/** Local open state so collapse can animate before `item.expanded` flips. */
const subsOpen = ref(props.item.expanded);
const opening = ref(false);
const closing = ref(false);
const chevOpen = ref(props.item.expanded);
let expandAnimLock = false;

const editorOpen = ref(false);
const editorOwner = ref<TeamMember | null>(null);
const editorTitle = ref('');
const editorPopOpen = ref(false);
const editorPopList = ref<TeamMember[]>([]);
const editorPopIdx = ref(0);
const editorPopQuery = ref<string | null>(null);
const editorInputRef = ref<HTMLInputElement | null>(null);
const editorDesc = ref('');
const editorDescOpen = ref(false);

const aliasOpen = ref(false);
const aliasTarget = ref<{ sub?: RoadmapSub }>({});
const aliasValue = ref('');
const aliasDesc = ref('');
const aliasDescOpen = ref(false);
const aliasOwner = ref<TeamMember | null>(null);
const aliasOwnerDirty = ref(false);
const aliasStyle = ref({ left: '0px', top: '4px' });
/** Draft bars edit the real title (used by Create Jira); non-drafts edit alias. */
const aliasEditingTitle = ref(false);

const assigneeMap = computed(() => teamAssigneeMap(state.snapshot.value));
const jiraBase = computed(
  () => state.snapshot.value?.team.jiraBaseUrl || 'https://jira.ringcentral.com',
);
const currentUser = computed(() => state.api.actorName.value || '');
/** Injected state is a plain object of refs; templates do not auto-unwrap nested refs. */
const isPop = computed(() => state.popKeys.value.includes(props.item.key));

function showName(name: string | null | undefined) {
  return dispName(assigneeMap.value, name);
}

function browseUrl(key: string | null | undefined) {
  if (!key) return '';
  return jiraBrowseUrl(key, jiraBase.value);
}

const disp = computed(() => props.item.alias || props.item.title);
const isDraft = computed(() => isDraftItem(props.item));
const itemDone = computed(() => isDoneStatus(props.item));
const dispKey = computed(() => itemDisplayKey(props.item));
const wrapMode = computed(() => shouldWrapAlias(props.item.alias));
const barW = computed(() => (props.item.days || 0) * DAY_W.value - 2);
const labelIn = computed(() => wrapMode.value || barW.value >= 110);
const visibleSubs = computed(() => props.item.subs.filter((s) => !s.cleared));
const nSubs = computed(() => visibleSubs.value.length);
const markers = computed(() => props.item.markers || []);
const onTrack = computed(() => trackMarkers(props.item));
const depCount = computed(() => markers.value.filter((m) => m.kind === 'dep').length);
const pendingDeps = computed(() => pendingDepCount(props.item));
const driftedDeps = computed(() => driftedDepCount(props.item));

const members = computed(() => state.snapshot.value?.members || []);

const teamRelParsed = computed(() => {
  const cfg = state.snapshot.value?.team.releaseSheet as
    | ReleaseSheetConfig
    | null
    | undefined;
  if (!cfg?.rows?.length) return null;
  return relParsed(cfg);
});

function barSprintTitle(start: string | null | undefined, days: number | null | undefined) {
  if (!start || !days || !teamRelParsed.value) return '';
  return catchReleaseHint(addD(start, days - 1), teamRelParsed.value);
}

function itemOpsHint() {
  return `单击展开 · 双击${isDraft.value ? '改任务名' : '改备注名'} · 拖动/两端拉伸排期${props.item.jiraKey ? ' · 左上 ↗ / ⌘单击打开 Jira' : ''}`;
}

function subOpsHint(s: RoadmapSub) {
  return `双击${s.temp ? '改任务名' : '改备注名'}/Owner · 拖动/两端拉伸${s.key ? ' · 左上 ↗ / ⌘单击打开 Jira' : ''}`;
}

function markerHandlers(): MarkerHandlers {
  return {
    editable: props.editable,
    hasExtension: state.hasExtension.value,
    toast: (html) => state.toast(html),
    addMarker: async (intent) => {
      if (props.applyMarkerIntent) await props.applyMarkerIntent(intent);
      else emit('addMarker', intent);
    },
    updateMarker: async (intent) => {
      if (props.applyMarkerIntent) await props.applyMarkerIntent(intent);
      else emit('updateMarker', intent);
    },
    deleteMarker: async (intent) => {
      if (props.applyMarkerIntent) await props.applyMarkerIntent(intent);
      else emit('deleteMarker', intent);
    },
    fetchIssueDates: state.hasExtension.value
      ? (jiraKey) => bridgeFetchIssueDates(jiraKey)
      : undefined,
    jiraBaseUrl: jiraBase.value,
  };
}

const memberColor = (name: string | null | undefined) =>
  members.value.find((m) => m.name === name)?.avatarColor || '#8895A5';

function findMember(name: string | null | undefined): TeamMember | null {
  if (!name) return null;
  return members.value.find((m) => m.name === name) || {
    id: '',
    name,
    avatarColor: '#8895A5',
  };
}

function barLeft() {
  return props.item.start ? X(props.tl, props.item.start) : 0;
}

function barDragStart(
  e: PointerEvent,
  sub: RoadmapSub | null,
  barEl: HTMLElement,
) {
  if (!props.editable || e.button !== 0) return;
  if ((e.target as HTMLElement).closest('.bar-x, .bar-plus, .bar-link')) return;

  // ⌘/Ctrl+click opens Jira (modifier+click = new tab muscle memory).
  const jiraKey = sub ? sub.key : props.item.jiraKey;
  if ((e.metaKey || e.ctrlKey) && jiraKey) {
    e.preventDefault();
    e.stopPropagation();
    window.open(browseUrl(jiraKey), '_blank', 'noopener');
    return;
  }

  e.preventDefault();

  const target = sub || props.item;
  const mode = (e.target as HTMLElement).classList.contains('hdl')
    ? (e.target as HTMLElement).classList.contains('l')
      ? 'l'
      : 'r'
    : 'move';
  const orig = {
    start: parseDate(target.start!),
    days: target.days!,
    x: e.clientX,
    y: e.clientY,
  };
  let moved = false;
  let scrolled = 0;
  let cancelled = false;
  const gs = barEl.closest('.gantt-scroll') as HTMLElement;
  const laneEl = barEl.parentElement as HTMLElement | null;
  const origLaneHeight = laneEl?.style.height ?? '';
  /** 「原位置」虚影：拖动时留在起点，拖回去即回到原位。 */
  let originEl: HTMLElement | null = null;
  type BarWithClickTimer = HTMLElement & {
    _ct?: ReturnType<typeof setTimeout> | null;
  };
  const barWithTimer = barEl as BarWithClickTimer;

  const live = { start: orig.start, days: orig.days };
  const hint = document.querySelector('.drag-hint') as HTMLElement;

  try {
    barEl.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  barEl.classList.add('drag-transform');
  barEl.classList.remove('anim');

  const showOriginGhost = () => {
    if (originEl || !laneEl) return;
    const w = orig.days * DAY_W.value - 2;
    originEl = document.createElement('div');
    originEl.className = sub ? 'drag-origin drag-origin-sub' : 'drag-origin';
    originEl.style.left = `${X(props.tl, orig.start)}px`;
    originEl.style.width = `${w}px`;
    originEl.style.top = `${barEl.offsetTop}px`;
    originEl.style.height = `${barEl.offsetHeight}px`;
    if (w >= 148) originEl.textContent = '原位置 · Esc 取消';
    laneEl.appendChild(originEl);
  };

  const applyVisual = () => {
    barEl.style.left = `${X(props.tl, live.start)}px`;
    barEl.style.width = `${live.days * DAY_W.value - 2}px`;
    if (barEl.classList.contains('free-h') && barEl.parentElement) {
      barEl.parentElement.style.height = `${barEl.offsetHeight + (sub ? 14 : 18)}px`;
    }
  };

  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - orig.x;
    const dy = ev.clientY - orig.y;
    if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    moved = true;
    barEl.classList.add('dragging');
    document.body.classList.add('no-select');
    showOriginGhost();

    if (gs) {
      const sr = gs.getBoundingClientRect();
      if (ev.clientX > sr.right - 50) {
        gs.scrollLeft += 14;
        scrolled += 14;
      } else if (ev.clientX < sr.left + 50) {
        const before = gs.scrollLeft;
        gs.scrollLeft = Math.max(0, before - 14);
        scrolled -= before - gs.scrollLeft;
      }
    }

    const dd = Math.round((dx + scrolled) / DAY_W.value);
    if (mode === 'move') {
      live.start = addD(
        orig.start,
        clamp(
          dd,
          diffD(orig.start, props.tl.start),
          diffD(addD(orig.start, orig.days - 1), props.tl.end),
        ),
      );
      if (!sub) barEl.style.transform = `translateY(${dy}px)`;
    } else if (mode === 'r') {
      live.days = clamp(orig.days + dd, 2, diffD(orig.start, props.tl.end) + 1);
    } else {
      const nd = clamp(orig.days - dd, 2, orig.days + diffD(props.tl.start, orig.start));
      live.start = addD(orig.start, orig.days - nd);
      live.days = nd;
    }
    applyVisual();
    if (hint) {
      hint.style.display = 'block';
      hint.style.left = `${ev.clientX + 14}px`;
      hint.style.top = `${ev.clientY - 34}px`;
      hint.textContent =
        `${fmtMD(live.start)} → ${fmtMD(addD(live.start, live.days - 1))} · ${live.days}d` +
        catchReleaseHint(addD(live.start, live.days - 1), teamRelParsed.value) +
        ' · Esc 取消';
    }
  };

  /** 落地与取消共用的收尾：拆监听、还原样式、移除原位置虚影。 */
  const finishDrag = () => {
    try {
      barEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    barEl.removeEventListener('pointermove', onMove);
    barEl.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKey, true);
    if (hint) hint.style.display = 'none';
    document.body.classList.remove('no-select');
    barEl.classList.remove('dragging', 'drag-transform');
    barEl.style.transform = '';
    originEl?.remove();
    originEl = null;
  };

  /** Esc：放弃本次拖动，bar 直接回到原位置，不提交任何变更。 */
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    cancelled = true;
    if (barWithTimer._ct) {
      clearTimeout(barWithTimer._ct);
      barWithTimer._ct = null;
    }
    barEl.style.left = `${X(props.tl, orig.start)}px`;
    barEl.style.width = `${orig.days * DAY_W.value - 2}px`;
    if (laneEl) laneEl.style.height = origLaneHeight;
    finishDrag();
  };

  const onUp = async (ev: PointerEvent) => {
    if (cancelled) return;
    finishDrag();

    if (!moved) {
      if (barWithTimer._ct) {
        clearTimeout(barWithTimer._ct);
        barWithTimer._ct = null;
        openAlias(sub);
      } else {
        barWithTimer._ct = setTimeout(() => {
          barWithTimer._ct = null;
          if (!sub) void requestToggleExpand();
        }, 230);
      }
      return;
    }

    let lane: number | undefined;
    if (!sub && mode === 'move' && Math.abs(ev.clientY - orig.y) > 30 && rowRef.value) {
      const rowEls = [...document.querySelectorAll('.g-row')].filter(
        (r) => r !== rowRef.value,
      );
      const others = state.scheduledItems.value.filter(
        (i) => i.key !== props.item.key,
      );
      let insertAt = others.length;
      for (let i = 0; i < rowEls.length; i++) {
        const r = rowEls[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          const key = (rowEls[i] as HTMLElement).dataset.key || '';
          const idx = others.findIndex((o) => o.key === key);
          insertAt = idx >= 0 ? idx : i;
          break;
        }
      }
      lane = insertAt;
    }

    // 拖了一圈又回到起点（原位置）：日期未变就不提交，避免留下无意义的活动记录。
    if (
      props.item.scheduled &&
      lane == null &&
      diffD(live.start, orig.start) === 0 &&
      live.days === orig.days
    ) {
      return;
    }

    emit('commit', {
      start: fmtISO(live.start),
      days: live.days,
      lane,
      op: sub
        ? undefined
        : props.item.scheduled
          ? lane != null
            ? 'move'
            : mode === 'move'
              ? 'move'
              : 'resize'
          : 'schedule',
      sub,
    });
  };

  barEl.addEventListener('pointermove', onMove);
  barEl.addEventListener('pointerup', onUp);
  // 捕获阶段监听，确保 Esc 先被拖拽吃掉（不被其他全局 Esc 处理器抢走）。
  window.addEventListener('keydown', onKey, true);
}

function parseDate(s: string) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function openAlias(sub: RoadmapSub | null) {
  aliasTarget.value = { sub: sub || undefined };
  const editingTitle = sub ? Boolean(sub.temp) : isDraftItem(props.item);
  aliasEditingTitle.value = editingTitle;
  const target = sub || props.item;
  aliasValue.value = editingTitle
    ? target.title || ''
    : target.alias || '';
  aliasOwner.value = sub ? findMember(sub.owner) : null;
  aliasOwnerDirty.value = false;
  aliasDesc.value = editingTitle ? String(target.description || '') : '';
  aliasDescOpen.value = editingTitle && Boolean(String(target.description || '').trim());
  // 先量后挂：编辑器首次挂载时 aliasStyle 还是默认的 left:0，浏览器 focus() 会把
  // .gantt-scroll 滚到最左侧去「露出」这个元素（任务在远处时视图直接跳回开头）。
  // 这里在 aliasOpen 之前就把真实坐标算好，首帧即落在 bar 上方。
  positionAliasEditor();
  aliasOpen.value = true;
  nextTick(() => {
    positionAliasEditor();
    const inp = rowRef.value?.querySelector('.alias-editor input') as HTMLInputElement | null;
    // preventScroll：双击改名时保持甘特当前滚动位置不变。
    inp?.focus({ preventScroll: true });
    inp?.select();
  });
}

function positionAliasEditor() {
  const root = rowRef.value;
  if (!root) return;
  const sub = aliasTarget.value.sub;
  const el = (
    sub
      ? root.querySelector(`[data-sub-id="${sub.id}"]`)
      : root.querySelector('.g-lane > .bar')
  ) as HTMLElement | null;
  if (!el) {
    aliasStyle.value = {
      left: `${sub?.start ? X(props.tl, sub.start) : barLeft()}px`,
      top: sub ? '62px' : '4px',
    };
    return;
  }
  const er = el.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  aliasStyle.value = {
    left: `${er.left - rr.left}px`,
    top: `${er.top - rr.top}px`,
  };
}

async function saveAlias() {
  const sub = aliasTarget.value.sub;
  const text = aliasValue.value.trim();
  if (aliasEditingTitle.value) {
    if (!text) {
      state.toast('任务名不能为空');
      return;
    }
    if (sub) {
      const intent: Record<string, unknown> = {
        op: 'update_sub',
        subId: sub.id,
        title: text,
        description: aliasDesc.value.trim() || null,
        baseVersion: sub.version,
      };
      if (aliasOwnerDirty.value) {
        intent.owner = aliasOwner.value?.name || null;
      }
      emit('updateSub', intent);
    } else {
      emit('setAlias', {
        op: 'update_item',
        itemKey: props.item.key,
        title: text,
        description: aliasDesc.value.trim() || null,
        baseVersion: props.item.version,
      });
    }
    aliasOpen.value = false;
    return;
  }
  const hadAlias = Boolean(sub ? sub.alias : props.item.alias);
  if (sub) {
    const intent: Record<string, unknown> = {
      op: 'update_sub',
      subId: sub.id,
      alias: text || null,
      baseVersion: sub.version,
    };
    if (aliasOwnerDirty.value) {
      intent.owner = aliasOwner.value?.name || null;
    }
    emit('updateSub', intent);
  } else {
    emit('setAlias', {
      op: 'set_alias',
      itemKey: props.item.key,
      alias: text || null,
      baseVersion: props.item.version,
    });
  }
  aliasOpen.value = false;
  if (!text && hadAlias) state.toast('备注名已清除，恢复展示原 ticket 名');
}

function cancelAlias() {
  aliasOpen.value = false;
  if (aliasOwnerDirty.value && aliasTarget.value.sub) {
    // Owner was changed live via float — persist even if Esc on alias.
    const sub = aliasTarget.value.sub;
    emit('updateSub', {
      op: 'update_sub',
      subId: sub.id,
      owner: aliasOwner.value?.name || null,
      baseVersion: sub.version,
    });
  }
}

function openAliasOwnerPop(chip: HTMLElement) {
  openOwnerFloat(
    chip,
    members.value,
    aliasOwner.value?.name,
    (m) => {
      aliasOwner.value = m;
      aliasOwnerDirty.value = true;
      const inp = rowRef.value?.querySelector('.alias-editor input') as HTMLInputElement | null;
      inp?.focus();
    },
    { allowClear: true, assigneeMap: assigneeMap.value },
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runExpand(after?: () => void) {
  if (subsOpen.value || closing.value) {
    after?.();
    return;
  }
  expandAnimLock = true;
  opening.value = true;
  chevOpen.value = true;
  subsOpen.value = true;
  await nextTick();
  if (rowRef.value) fitLanes(rowRef.value);
  const el = subsRef.value;
  if (el) {
    const h = el.scrollHeight;
    el.style.height = '0px';
    el.getBoundingClientRect();
    el.style.height = `${h}px`;
    await sleep(340);
    el.style.height = '';
  }
  opening.value = false;
  expandAnimLock = false;
  after?.();
}

async function runCollapse() {
  if (!subsOpen.value || opening.value) return;
  expandAnimLock = true;
  closing.value = true;
  chevOpen.value = false;
  const el = subsRef.value;
  if (el) {
    el.style.height = `${el.offsetHeight}px`;
    el.getBoundingClientRect();
    el.style.height = '0px';
    await sleep(300);
  }
  subsOpen.value = false;
  closing.value = false;
  if (el) el.style.height = '';
  expandAnimLock = false;
}

async function persistToggle(open: boolean) {
  if (props.persistToggle) await props.persistToggle(open);
  else emit('toggleExpand', open);
}

/** Demo-parity expand/collapse: height slide + staggered subIn, then persist locally. */
async function requestToggleExpand() {
  if (subsOpen.value) {
    await runCollapse();
    try {
      await persistToggle(false);
    } catch {
      await runExpand();
    }
  } else {
    try {
      await runExpand();
      await persistToggle(true);
    } catch {
      await runCollapse();
    }
  }
}

async function expandThenEdit() {
  if (!props.editable) return;
  if (subsOpen.value) {
    showEditor();
    return;
  }
  try {
    await runExpand(() => showEditor());
    await persistToggle(true);
  } catch {
    await runCollapse();
  }
}

function showEditor() {
  editorOpen.value = true;
  editorTitle.value = '';
  editorDesc.value = '';
  editorDescOpen.value = false;
  editorOwner.value = null;
  editorPopOpen.value = false;
  editorPopQuery.value = null;
  nextTick(() => editorInputRef.value?.focus());
}

// Local expand overlay: animate when this viewer's expandedKeys change
// (URL restore / setItemExpanded). Other users' actions never flip this.
watch(
  () => props.item.expanded,
  (next) => {
    if (expandAnimLock) return;
    if (next && !subsOpen.value) void runExpand();
    else if (!next && subsOpen.value) void runCollapse();
  },
);

watch(
  () => props.item.key,
  () => {
    subsOpen.value = props.item.expanded;
    chevOpen.value = props.item.expanded;
    opening.value = false;
    closing.value = false;
  },
);

function selectEditorOwner(m: TeamMember) {
  editorOwner.value = m;
  editorTitle.value =
    editorTitle.value.replace(/@[^@]*$/, '').trimEnd() +
    (editorTitle.value.match(/@[^@]*$/) ? ' ' : '');
  closeEditorPop();
  editorInputRef.value?.focus();
}

function openEditorPop(q: string) {
  editorPopQuery.value = q;
  editorPopIdx.value = 0;
  const ql = (q || '').toLowerCase();
  editorPopList.value = members.value.filter(
    (o) =>
      o.name.toLowerCase().includes(ql) ||
      showName(o.name).toLowerCase().includes(ql),
  );
  editorPopOpen.value = true;
}

function closeEditorPop() {
  editorPopOpen.value = false;
  editorPopQuery.value = null;
}

function onEditorInput() {
  const m = editorTitle.value.match(/@([^@]*)$/);
  if (m) openEditorPop(m[1]);
  else closeEditorPop();
}

function onEditorKeydown(e: KeyboardEvent) {
  if (editorPopOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (editorPopList.value.length) {
        editorPopIdx.value = (editorPopIdx.value + 1) % editorPopList.value.length;
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (editorPopList.value.length) {
        editorPopIdx.value =
          (editorPopIdx.value - 1 + editorPopList.value.length) %
          editorPopList.value.length;
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (editorPopList.value.length) {
        selectEditorOwner(editorPopList.value[editorPopIdx.value]);
      } else if (editorPopQuery.value?.trim()) {
        const name = editorPopQuery.value.trim();
        selectEditorOwner({ id: '', name, avatarColor: '#8895A5' });
      } else {
        closeEditorPop();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditorPop();
      return;
    }
  }
  if (e.key === 'Escape') {
    editorOpen.value = false;
    return;
  }
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    editorDescOpen.value = true;
    nextTick(() => {
      (rowRef.value?.querySelector('.te-desc') as HTMLTextAreaElement | null)?.focus();
    });
    return;
  }
  if (e.key === 'Enter' && editorTitle.value.trim()) {
    e.preventDefault();
    submitSub();
  }
}

function openEditorOwnerChip(chip: HTMLElement) {
  closeEditorPop();
  openOwnerFloat(
    chip,
    members.value,
    editorOwner.value?.name,
    (m) => {
      editorOwner.value = m;
      editorInputRef.value?.focus();
    },
    { allowClear: true, assigneeMap: assigneeMap.value },
  );
}

async function submitSub() {
  const title = editorTitle.value.trim();
  if (!title) {
    editorOpen.value = false;
    return;
  }
  const span = defaultNewSubSpan(props.tl.end);
  emit('addSub', {
    op: 'add_sub',
    itemKey: props.item.key,
    title,
    owner: editorOwner.value?.name || null,
    start: span.start,
    days: span.days,
    description: editorDesc.value.trim() || null,
  });
  editorOpen.value = false;
}

function toggleEditorDesc() {
  editorDescOpen.value = !editorDescOpen.value;
  nextTick(() => {
    if (editorDescOpen.value) {
      (rowRef.value?.querySelector('.te-desc') as HTMLTextAreaElement | null)?.focus();
    } else {
      editorInputRef.value?.focus();
    }
  });
}

function toggleAliasDesc() {
  aliasDescOpen.value = !aliasDescOpen.value;
  nextTick(() => {
    const sel = aliasDescOpen.value ? '.alias-editor .desc-input' : '.alias-editor input';
    (rowRef.value?.querySelector(sel) as HTMLElement | null)?.focus();
  });
}

function onDescInput(which: 'editor' | 'alias', ev: Event) {
  const el = ev.target as HTMLTextAreaElement;
  const next = clampDescription(el.value);
  if (next !== el.value) el.value = next;
  if (which === 'editor') editorDesc.value = next;
  else aliasDesc.value = next;
}

function onEditorFocusOut() {
  setTimeout(() => {
    const ed = rowRef.value?.querySelector('.task-editor');
    if (!ed || !document.body.contains(ed)) return;
    if (ed.contains(document.activeElement) || document.querySelector('.owner-float')) return;
    editorOpen.value = false;
  }, 150);
}

function onAliasFocusOut() {
  setTimeout(() => {
    const ed = rowRef.value?.querySelector('.alias-editor');
    if (!ed || !document.body.contains(ed)) return;
    if (ed.contains(document.activeElement) || document.querySelector('.owner-float')) return;
    cancelAlias();
  }, 150);
}

function onAliasTitleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    cancelAlias();
    return;
  }
  if (e.key === 'Enter' && e.shiftKey && aliasEditingTitle.value) {
    e.preventDefault();
    aliasDescOpen.value = true;
    nextTick(() => {
      (rowRef.value?.querySelector('.alias-editor .desc-input') as HTMLTextAreaElement | null)?.focus();
    });
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    void saveAlias();
  }
}

function onDescKeydown(e: KeyboardEvent, submit: () => void) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    if (editorOpen.value) editorOpen.value = false;
    else cancelAlias();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function suggestAlias() {
  if (aliasEditingTitle.value) return;
  const target = aliasTarget.value.sub || props.item;
  const t = target.title.split(/[:：]/)[0].trim();
  aliasValue.value = t.length > 34 ? `${t.slice(0, 32)}…` : t;
}

onMounted(() => {
  nextTick(() => {
    if (rowRef.value) fitLanes(rowRef.value);
  });
});

watch(
  () => [props.item.alias, onTrack.value.length, props.item.days, wrapMode.value] as const,
  () => nextTick(() => {
    if (rowRef.value) fitLanes(rowRef.value);
  }),
);
</script>

<template>
  <div ref="rowRef" class="g-row" :data-key="item.key">
    <div class="g-lane">
      <div
        class="bar"
        :class="[
          itemDone ? 'done' : item.start && item.days ? colorCls(item.start, item.days) : '',
          { 'free-h': wrapMode, enter: enter, draft: isDraft && !itemDone, pop: isPop },
        ]"
        :style="{ left: `${barLeft()}px`, width: `${barW}px` }"
        :data-tip="`${dispKey} · ${item.start ? fmtMD(item.start) : ''} → ${item.start && item.days ? fmtMD(addD(item.start, item.days - 1)) : ''} · ${item.days}d${isDraft ? ' · 未创建 Jira' : ''}${barSprintTitle(item.start, item.days)}${itemDone ? ` · ${item.status}` : ''}||${item.title}||${tooltipHintLine(item.description, itemOpsHint())}`"
        :data-pai-item="item.key"
        :data-pai-team="teamId"
        :data-pai-target-start="item.targetStart || ''"
        :data-pai-target-end="item.targetEnd || ''"
        @pointerdown="barDragStart($event, null, $event.currentTarget as HTMLElement)"
      >
        <div v-if="wrapMode" class="wrap-label">{{ itemDone ? '✓ ' : '' }}{{ esc(disp) }}</div>
        <span v-else-if="labelIn" class="in-label">{{ itemDone ? '✓ ' : '' }}{{ esc(disp) }}</span>
        <span v-else class="out-label">{{ itemDone ? '✓ ' : '' }}{{ disp }}</span>
        <a
          v-if="item.jiraKey"
          class="bar-link"
          :href="browseUrl(item.jiraKey)"
          target="_blank"
          rel="noopener"
          data-tip="在 Jira 打开"
          @pointerdown.stop
          @click.stop
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 3H3.5A1.5 1.5 0 002 4.5v4A1.5 1.5 0 003.5 10h4A1.5 1.5 0 009 8.5V7M7 2h3v3M5.5 6.5L10 2" />
          </svg>
        </a>
        <span v-if="depCount || nSubs" class="badge-cluster">
          <span
            v-if="depCount"
            class="dep-badge"
            :class="{ pending: pendingDeps > 0, drift: pendingDeps === 0 && driftedDeps > 0 }"
            :data-tip="depBadgeTip(item)"
            @pointerdown.stop
            @click.stop="openDepPopover($event.currentTarget as HTMLElement, item, markerHandlers())"
            v-html="linkIconHtml(8) + depCount"
          />
          <span v-if="nSubs" class="sub-badge">
            <svg
              class="chev"
              :class="{ up: chevOpen }"
              width="8"
              height="8"
              viewBox="0 0 10 10"
            >
              <path
                d="M2 3.5l3 3 3-3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {{ nSubs }}
          </span>
        </span>
        <div class="hdl l" />
        <div class="hdl r" />
        <div class="pai-overlay-slot" />
        <button
          v-if="editable"
          class="bar-x"
          data-tip="退回 Backlog"
          @pointerdown.stop
          @click.stop="emit('unschedule')"
        >
          ×
        </button>
      </div>
      <button
        v-if="editable"
        class="bar-plus"
        :style="{ left: `${Math.max(2, barLeft() - 33)}px` }"
        data-tip="添加任务"
        @pointerdown.stop
        @click.stop="expandThenEdit"
      >
        <svg viewBox="0 0 14 14" width="13" height="13">
          <path
            d="M7 2.5v9M2.5 7h9"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        v-if="editable"
        class="marker-plus"
        :style="{ left: `${barLeft() + barW + 18}px` }"
        data-tip="添加阶段节点 / 外部依赖"
        @pointerdown.stop
        @click.stop="openMarkerMenu($event.currentTarget as HTMLElement, item, markerHandlers())"
      >
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
          <path d="M3.2 12.5V2M3.2 2.5h6.8l-1.9 2.6L10 7.5H3.2" />
        </svg>
      </button>
      <div v-if="onTrack.length" class="marker-track">
        <button
          v-for="m in onTrack"
          :key="m.id"
          type="button"
          class="marker"
          :class="[{ done: isMarkerDone(m.date), dep: m.kind === 'dep', drift: m.kind === 'dep' && depEtaMismatchesJira(m) }]"
          :style="{
            left: `${X(tl, m.date!) + DAY_W / 2}px`,
            background: m.kind === 'dep' ? '#7C8794' : phaseColor(m),
          }"
          :data-tip="
            m.kind === 'phase'
              ? `${m.label} · ${fmtMD(m.date!)}${isMarkerDone(m.date) ? ' · 已完成' : ' · 待完成'}||阶段节点||左右拖动改期 · 单击编辑或删除`
              : depHoverTip(m)
          "
          @pointerdown="
            markerDragStart($event, {
              marker: m,
              item,
              tl,
              handlers: markerHandlers(),
            })
          "
        >
          <span v-if="m.kind === 'phase'" class="m-glyph">{{ phaseGlyph(m) }}</span>
          <span v-else class="m-glyph" v-html="linkIconHtml(9)" />
        </button>
      </div>
    </div>

    <div
      v-if="subsOpen"
      ref="subsRef"
      class="g-subs"
      :class="{ opening, closing }"
      :style="{ '--guide-x': `${barLeft() + 4}px` }"
    >
      <div v-for="(s, si) in visibleSubs" :key="s.id" class="sub-lane">
        <div
          class="sbar"
          :data-sub-id="s.id"
          :class="[
            isDoneStatus(s) ? 'done' : s.temp ? 'draft' : s.start && s.days ? colorCls(s.start, s.days) : '',
            { 'free-h': shouldWrapAlias(s.alias) },
          ]"
          :style="{
            left: `${s.start ? X(tl, s.start) : 0}px`,
            width: `${(s.days || 0) * DAY_W - 2}px`,
            animationDelay: opening ? `${si * 45}ms` : undefined,
            animation:
              !opening && s.id === newSubId
                ? 'subIn .34s cubic-bezier(.22,1,.36,1) backwards'
                : undefined,
          }"
          :data-tip="`${s.key || '草稿 · 未创建到 Jira'}${s.createdBy && s.createdBy !== currentUser ? ` · 由 ${showName(s.createdBy)} 添加` : ''} · ${s.start ? fmtMD(s.start) : ''} → ${s.start && s.days ? fmtMD(addD(s.start, s.days - 1)) : ''} · ${s.days}d${s.owner ? ` · Owner ${showName(s.owner)}` : ''}${barSprintTitle(s.start, s.days)}${isDoneStatus(s) ? ` · ${s.status}` : ''}||${s.title}||${tooltipHintLine(s.description, subOpsHint(s))}`"
          @pointerdown="barDragStart($event, s, $event.currentTarget as HTMLElement)"
        >
          <div v-if="shouldWrapAlias(s.alias)" class="wrap-label">{{ isDoneStatus(s) ? '✓ ' : '' }}{{ esc(s.alias!) }}</div>
          <span v-else class="in-label">
            <span v-if="s.key" style="font-family: var(--mono); font-size: 9.5px; opacity: 0.75">{{ s.key }}</span>
            {{ s.key ? ' · ' : '' }}{{ isDoneStatus(s) ? '✓ ' : '' }}{{ esc(s.alias || s.title) }}
          </span>
          <span
            v-if="s.createdBy && s.createdBy !== currentUser"
            class="creator-tag"
          >{{ showName(s.createdBy) }} created</span>
          <span
            v-if="s.owner"
            class="own-av sbar-owner"
            :style="{ background: memberColor(s.owner) }"
            :data-tip="`Owner：${showName(s.owner)}`"
          >
            {{ initials(s.owner) }}
          </span>
          <a
            v-if="s.key"
            class="bar-link"
            :href="browseUrl(s.key)"
            target="_blank"
            rel="noopener"
            data-tip="在 Jira 打开"
            @pointerdown.stop
            @click.stop
          >
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 3H3.5A1.5 1.5 0 002 4.5v4A1.5 1.5 0 003.5 10h4A1.5 1.5 0 009 8.5V7M7 2h3v3M5.5 6.5L10 2" />
            </svg>
          </a>
          <div class="hdl l" />
          <div class="hdl r" />
          <button
            v-if="editable"
            class="bar-x"
            :data-tip="s.temp ? '删除草稿' : '从 Roadmap 移除（可再导入）'"
            @pointerdown.stop
            @click.stop="emit('deleteSub', { op: 'delete_sub', subId: s.id })"
          >
            ×
          </button>
        </div>
      </div>
      <div v-if="editorOpen" class="add-lane">
        <div class="task-editor" :style="{ left: `${barLeft()}px` }" @focusout="onEditorFocusOut">
          <div class="te-row">
          <div class="te-box">
            <button
              class="te-owner"
              type="button"
              :data-tip="
                editorOwner
                  ? `Owner：${showName(editorOwner.name)}（点击更换）`
                  : 'Owner（可选）：点选或在标题里输入 @'
              "
              @pointerdown.prevent
              @click="openEditorOwnerChip($event.currentTarget as HTMLElement)"
              v-html="memberChipHtml(editorOwner)"
            />
            <input
              ref="editorInputRef"
              v-model="editorTitle"
              placeholder="任务标题，@ 可指定 Owner，Enter 创建…"
              @input="onEditorInput"
              @keydown="onEditorKeydown"
            />
            <button
              class="desc-toggle"
              type="button"
              :class="{ on: editorDescOpen, filled: !!editorDesc.trim() }"
              data-tip="描述（可选）：背景 / 交付物 / 验收要点||创建 Jira 时并入 AI 生成 description；hover 任务条可见||Shift+Enter 也可展开"
              @pointerdown.prevent
              @click="toggleEditorDesc"
            ><span class="dot"></span>≡ 描述</button>
            <div class="owner-pop" :class="{ show: editorPopOpen }">
              <div class="owner-list">
                <template v-if="editorPopList.length">
                  <div
                    v-for="(o, i) in editorPopList"
                    :key="o.id || o.name"
                    class="owner-item"
                    :class="{ act: i === editorPopIdx }"
                    @pointerdown.prevent.stop="selectEditorOwner(o)"
                  >
                    <span class="own-av" :style="{ background: o.avatarColor }">{{ initials(o.name) }}</span>
                    {{ showName(o.name) }}
                  </div>
                </template>
                <div v-else class="owner-none">
                  无匹配成员 —— Enter 将「{{ editorPopQuery || '' }}」作为自定义 Owner
                </div>
              </div>
            </div>
          </div>
          <span class="te-hint">Enter 创建 · Esc 取消</span>
          </div>
          <textarea
            v-if="editorDescOpen"
            class="desc-input te-desc"
            :value="editorDesc"
            :maxlength="DESCRIPTION_MAX_CHARS"
            placeholder="描述（可选）：背景 / 交付物 / 验收要点。Enter 创建，Shift+Enter 换行"
            @input="onDescInput('editor', $event)"
            @keydown="onDescKeydown($event, submitSub)"
          />
        </div>
      </div>
      <div v-else-if="editable" class="add-lane">
        <button
          class="add-ghost"
          :style="{
            left: `${barLeft()}px`,
            animationDelay: opening ? `${visibleSubs.length * 45}ms` : undefined,
          }"
          @click="showEditor"
        >          <svg width="11" height="11" viewBox="0 0 14 14">
            <path
              d="M7 2.5v9M2.5 7h9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
          添加任务
        </button>
      </div>
    </div>

    <div
      v-if="aliasOpen"
      class="alias-editor"
      :style="aliasStyle"
      @pointerdown.stop
      @focusout="onAliasFocusOut"
    >
      <div class="ae-row">
      <button
        v-if="aliasTarget.sub"
        class="te-owner ae-owner"
        type="button"
        :data-tip="
          aliasOwner ? `Owner：${showName(aliasOwner.name)}（点击更换）` : '设置 Owner'
        "
        @pointerdown.prevent.stop
        @click="openAliasOwnerPop($event.currentTarget as HTMLElement)"
        v-html="memberChipHtml(aliasOwner)"
      />
      <input
        v-model="aliasValue"
        :placeholder="
          aliasEditingTitle
            ? '输入任务名（创建 Jira 时使用）'
            : '输入备注名（显示名），留空恢复原名'
        "
        @keydown="onAliasTitleKeydown"
      />
      <button
        v-if="aliasEditingTitle"
        class="desc-toggle"
        type="button"
        :class="{ on: aliasDescOpen, filled: !!aliasDesc.trim() }"
        data-tip="描述（可选）||创建 Jira 时与父 Epic 描述一起交给 AI 综合生成最终 description；hover 任务条可见"
        @pointerdown.prevent
        @click="toggleAliasDesc"
      ><span class="dot"></span>≡ 描述</button>
      <button
        v-if="!aliasEditingTitle"
        class="ae-ai"
        type="button"
        @click="suggestAlias"
      >✦ AI 缩写</button>
      <span class="ae-hint">{{
        aliasEditingTitle
          ? 'Enter 保存 · Esc 取消'
          : 'Enter 保存 · 清空回车＝恢复原 ticket 名 · Esc 取消'
      }}</span>
      </div>
      <textarea
        v-if="aliasEditingTitle && aliasDescOpen"
        class="desc-input"
        :value="aliasDesc"
        :maxlength="DESCRIPTION_MAX_CHARS"
        placeholder="描述（可选）：背景 / 交付物 / 验收要点。Enter 保存，Shift+Enter 换行"
        @input="onDescInput('alias', $event)"
        @keydown="onDescKeydown($event, saveAlias)"
      />
    </div>
  </div>
</template>
