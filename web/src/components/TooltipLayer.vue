<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { esc } from '../composables/useGeometry';

const tip = ref<HTMLElement | null>(null);
const show = ref(false);
const html = ref('');
const pos = ref({ x: 0, y: 0 });

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function onOver(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
  if (!el) {
    show.value = false;
    return;
  }
  const [head, body, hint] = (el.dataset.tip || '').split('||');
  html.value =
    (body
      ? `<div class="tt-head">${esc(head)}</div><div class="tt-body">${esc(body)}</div>`
      : `<div class="tt-body">${esc(head)}</div>`) +
    (hint ? `<div class="tt-hint">${esc(hint)}</div>` : '');
  show.value = true;
}

function onMove(e: MouseEvent) {
  if (!show.value || !tip.value) return;
  const r = tip.value.getBoundingClientRect();
  pos.value = {
    x: clamp(e.clientX + 14, 8, innerWidth - r.width - 10),
    y: clamp(e.clientY + 16, 8, innerHeight - r.height - 10),
  };
}

function hide() {
  show.value = false;
}

onMounted(() => {
  document.addEventListener('mouseover', onOver);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseleave', hide);
  document.addEventListener('pointerdown', hide, true);
});
onUnmounted(() => {
  document.removeEventListener('mouseover', onOver);
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseleave', hide);
  document.removeEventListener('pointerdown', hide, true);
});
</script>

<template>
  <div
    ref="tip"
    class="tooltip"
    :class="{ show }"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    v-html="html"
  />
</template>
