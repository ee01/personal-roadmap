<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import type { RoadmapItem, RoadmapMarker } from '../types';
import {
  addD,
  clamp,
  DAY_W,
  diffD,
  fmtISO,
  fmtMD,
  X,
  type Timeline,
} from '../composables/useGeometry';
import {
  dependencyGap,
  dependencyDrift,
  dependencyState,
  snapDependencyNeed,
} from '../composables/dependency';
import {
  openDepPopover,
  type MarkerHandlers,
} from '../composables/useMarkerFloats';
const props = defineProps<{
  marker: RoadmapMarker;
  item: RoadmapItem;
  tl: Timeline;
  handlers: MarkerHandlers;
  full?: boolean;
}>();
const track = ref<HTMLElement>();
const preview = ref<string | undefined>();
const undo = ref<{ need: string | null; version: number } | null>(null);
const need = computed(
  () => preview.value || props.marker.need || props.marker.date,
);
const gap = computed(() =>
  dependencyGap({ ...props.marker, need: need.value }),
);
const state = computed(() =>
  dependencyState({ ...props.marker, need: need.value }),
);
const driftLine = computed(() => {
  const from = props.marker.date || need.value;
  const to = props.marker.jiraTargetEnd;
  if (!from || !to) return {};
  return {
    left: `${Math.min(x(from), x(to))}px`,
    width: `${Math.abs(x(from) - x(to))}px`,
  };
});
const x = (d: string) => X(props.tl, d) + DAY_W.value / 2;
const line = computed(() => ({
  left: `${Math.min(x(need.value!), x(props.marker.date!))}px`,
  width: `${Math.abs(x(need.value!) - x(props.marker.date!))}px`,
}));
watch(
  () => props.marker.version,
  (version) => {
    if (undo.value && version !== undo.value.version) undo.value = null;
  },
);
let cleanup: (() => void) | undefined;
onBeforeUnmount(() => cleanup?.());
async function save(date: string, snap = true, focus = false) {
  const next = snap
    ? snapDependencyNeed(date, props.marker.date)
    : date === props.marker.date
      ? null
      : date;
  if (next === (props.marker.need || null)) return;
  const previous = props.marker.need || null;
  const version = props.marker.version;
  try {
    await props.handlers.updateMarker({
      op: 'update_marker',
      markerId: props.marker.id,
      itemKey: props.item.key,
      need: next,
      baseVersion: version,
    });
    undo.value = { need: previous, version: version + 1 };
    if (focus) {
      await nextTick();
      (
        track.value?.querySelector<HTMLElement>('.need') ||
        track.value?.querySelector<HTMLElement>('.eta')
      )?.focus();
    }
    props.handlers.toast(
      `期望时间已改为 ${fmtMD(next || props.marker.date!)} · ETA 保持 ${props.marker.date ? fmtMD(props.marker.date) : '未确认'}`,
    );
  } catch {
    /* API displays the error */
  }
}
async function restore() {
  if (!undo.value) return;
  try {
    await props.handlers.updateMarker({
      op: 'update_marker',
      markerId: props.marker.id,
      itemKey: props.item.key,
      need: undo.value.need,
      baseVersion: undo.value.version,
    });
    undo.value = null;
  } catch {
    undo.value = null;
  }
}
function drag(e: PointerEvent, origin: string) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const start = e.clientX;
  const from = props.marker.need || origin;
  const scroll = el.closest<HTMLElement>('.gantt-scroll, .dependency-scroll');
  let scrolled = 0;
  let moved = false;
  const move = (event: PointerEvent) => {
    if (
      !props.handlers.editable ||
      (Math.abs(event.clientX - start) < 3 && !moved)
    )
      return;
    moved = true;
    if (scroll) {
      const r = scroll.getBoundingClientRect();
      const before = scroll.scrollLeft;
      if (event.clientX > r.right - 40) scroll.scrollLeft += 14;
      else if (event.clientX < r.left + (props.full ? 400 : 40))
        scroll.scrollLeft -= 14;
      scrolled += scroll.scrollLeft - before;
    }
    const dd = Math.round((event.clientX - start + scrolled) / DAY_W.value);
    const d = fmtISO(
      addD(
        from,
        clamp(dd, diffD(from, props.tl.start), diffD(from, props.tl.end)),
      ),
    );
    preview.value =
      props.marker.date && Math.abs(diffD(d, props.marker.date)) <= 1
        ? props.marker.date
        : d;
  };
  cleanup = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  };
  const cancel = () => {
    cleanup?.();
    preview.value = undefined;
  };
  const up = async () => {
    cleanup?.();
    if (!moved) openDepPopover(el, props.item, props.handlers, props.marker.id);
    else if (preview.value) await save(preview.value);
    preview.value = undefined;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
  window.addEventListener('pointercancel', cancel, { once: true });
}
// Serialize repeated key presses so each intent uses the version returned by the previous one.
let keyboardPending: string | undefined;
let keyboardRunning = false;
async function queueKeyboard(date: string) {
  keyboardPending = date;
  preview.value = date;
  if (keyboardRunning) return;
  keyboardRunning = true;
  try {
    while (keyboardPending) {
      const target = keyboardPending;
      keyboardPending = undefined;
      await save(target, false, true);
      await nextTick();
    }
  } finally {
    keyboardRunning = false;
    preview.value = undefined;
  }
}
function key(e: KeyboardEvent, date: string) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openDepPopover(
      e.currentTarget as HTMLElement,
      props.item,
      props.handlers,
      props.marker.id,
    );
    return;
  }
  if (!props.handlers.editable || !['ArrowLeft', 'ArrowRight'].includes(e.key))
    return;
  e.preventDefault();
  void queueKeyboard(
    fmtISO(
      addD(
        need.value || date,
        (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1),
      ),
    ),
  );
}
</script>
<template>
  <div
    ref="track"
    class="dependency-track"
    :class="[
      state,
      { full, drifted: state !== 'done' && dependencyDrift(marker) },
    ]"
    :data-dep-id="marker.id"
  >
    <div
      v-if="marker.date && need && need !== marker.date"
      class="dependency-gap"
      :class="{ late: gap > 0 && state !== 'done' }"
      :style="line"
    >
      <span v-if="full || gap > 0">{{
        gap > 0 ? (full ? '晚 ' : '+') + gap + 'd' : '余量 ' + -gap + 'd'
      }}</span>
    </div>
    <button
      v-if="marker.date"
      class="dependency-point eta"
      :style="{ left: `${x(marker.date)}px` }"
      :aria-label="`${marker.label} ETA ${marker.date}，拖动改期望`"
      :data-tip="`${marker.label}||ETA ${marker.date} · 期望 ${need || marker.date}||拖动改期望 · 单击查看 · 方向键调整`"
      @pointerdown="drag($event, marker.date)"
      @keydown="key($event, marker.date)"
    />
    <button
      v-if="need && (need !== marker.date || !marker.date)"
      class="dependency-point need"
      :style="{ left: `${x(need)}px` }"
      :aria-label="`${marker.label} 期望 ${need}`"
      :data-tip="`${marker.label}||期望 ${need} · ETA ${marker.date || '未确认'}||拖动改期望 · 单击填写或刷新 ETA`"
      @pointerdown="drag($event, need)"
      @keydown="key($event, need)"
    >
      {{ marker.date ? '' : '?' }}
    </button>
    <div
      v-if="full && marker.jiraTargetStart && marker.jiraTargetEnd"
      class="dependency-ticket"
      :style="{
        left: `${x(marker.jiraTargetStart)}px`,
        width: `${Math.max(3, x(marker.jiraTargetEnd) - x(marker.jiraTargetStart))}px`,
      }"
      :title="`Ticket Target: ${marker.jiraTargetStart} → ${marker.jiraTargetEnd}`"
    />
    <div
      v-if="
        full &&
        dependencyDrift(marker) &&
        marker.jiraTargetEnd &&
        (marker.date || need)
      "
      class="dependency-drift-link"
      :style="driftLine"
    />
    <div
      v-if="full && dependencyDrift(marker) && marker.jiraTargetEnd"
      class="dependency-drift"
      :style="{ left: `${x(marker.jiraTargetEnd)}px` }"
      :title="`Jira Target End ${marker.jiraTargetEnd}`"
    >
      ◇<span>Jira {{ fmtMD(marker.jiraTargetEnd) }}</span>
    </div>
    <div
      v-if="full && !marker.date && need"
      class="dependency-unknown"
      :style="{ left: `${x(need)}px` }"
    />
    <button
      v-if="undo && handlers.editable"
      class="dependency-undo"
      :style="{ left: `${x(need || marker.date!) + 15}px` }"
      @pointerdown.stop
      @click.stop="restore"
    >
      撤销
    </button>
  </div>
</template>
<style>
.dependency-track {
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: #7c8794;
}
.dependency-track.late,
.dependency-track.missing,
.dependency-track.stale {
  color: var(--danger);
}
.dependency-track.drifted .eta {
  box-shadow: 0 0 0 2px #c9842a66;
}
.dependency-track.done {
  color: #559273;
  opacity: 0.65;
}
.dependency-point {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  border: 0;
  border-radius: 50%;
  width: 13px;
  height: 13px;
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
  background: currentColor;
  color: inherit;
  padding: 0;
  z-index: 3;
}
.dependency-point.need {
  width: 19px;
  height: 19px;
  border: 1.5px dashed currentColor;
  background: var(--surface, #fff);
  font-size: 10px;
  font-weight: 700;
}
.dependency-point:hover,
.dependency-point:focus-visible {
  outline: 3px solid #abb6c955;
  z-index: 5;
}
.dependency-gap {
  position: absolute;
  top: 50%;
  border-top: 1px dashed currentColor;
  height: 1px;
}
.dependency-gap.late {
  border-top: 1px solid currentColor;
}
.dependency-gap span {
  position: absolute;
  left: 50%;
  bottom: 3px;
  font: 9px var(--mono);
  white-space: nowrap;
  transform: translateX(-50%);
}
.full .dependency-gap.late {
  height: 18px;
  transform: translateY(-50%);
  background: #e4573d20;
  border-block: 1px solid #e4573d55;
}
.full .dependency-gap span {
  bottom: 20px;
}
.full .dependency-point {
  top: 42%;
}
.full .dependency-gap {
  top: 42%;
}
.dependency-ticket {
  position: absolute;
  top: 72%;
  height: 6px;
  border: 1px solid #8293a688;
  background: repeating-linear-gradient(
    125deg,
    #8293a644 0 2px,
    transparent 2px 5px
  );
}
.dependency-drift-link {
  position: absolute;
  top: 30%;
  border-top: 1px dashed #c9842a;
  opacity: 0.8;
}
.dependency-drift-link::after {
  content: '›';
  position: absolute;
  right: -2px;
  top: -8px;
  color: #c9842a;
}
.dependency-drift {
  position: absolute;
  top: 30%;
  color: #c9842a;
  border-bottom: 1px dashed #c9842a;
}
.dependency-drift span {
  font-size: 9px;
  white-space: nowrap;
}
.dependency-unknown {
  position: absolute;
  top: 42%;
  width: 100px;
  border-top: 1px dashed currentColor;
  mask-image: linear-gradient(to right, #000, transparent);
}
.dependency-undo {
  position: absolute;
  top: 70%;
  font-size: 9px;
  pointer-events: auto;
  z-index: 6;
  white-space: nowrap;
}
.marker-track .dependency-track:hover {
  z-index: 8;
  filter: drop-shadow(0 0 2px currentColor);
}
.marker-track:has(.dependency-track:hover) .dependency-track:not(:hover) {
  opacity: 0.25;
}
</style>
