<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoadmapState } from '../../composables/useRoadmapState';
import {
  EXTENSION_FEATURES,
  EXTENSION_PERKS,
  useExtensionGate,
} from '../../composables/useExtensionGate';

const state = useRoadmapState();
const gate = useExtensionGate();

const feature = computed(() => EXTENSION_FEATURES[gate.gateFeature.value]);

/** A content script only injects on load, so detection needs a real reload. */
function reload() {
  window.location.reload();
}

// If the bridge shows up while the guide is open, confirm and step aside.
watch(
  () => state.hasExtension.value && gate.gateOpen.value,
  (unlocked) => {
    if (!unlocked) return;
    setTimeout(() => gate.closeGate(), 1200);
  },
);
</script>

<template>
  <div class="modal-back" :class="{ show: gate.gateOpen.value }" @click.self="gate.closeGate()">
    <div class="modal modal-ext">
      <div class="m-head eg-head">
        <div class="eg-badge">
          <svg width="19" height="19" viewBox="0 0 16 16">
            <path
              d="M6.4 2.2a1.6 1.6 0 013.2 0v.9h2a.9.9 0 01.9.9v2h.9a1.6 1.6 0 010 3.2h-.9v2a.9.9 0 01-.9.9h-2v-.9a1.6 1.6 0 00-3.2 0v.9h-2a.9.9 0 01-.9-.9v-2h-.9a1.6 1.6 0 010-3.2h.9V4a.9.9 0 01.9-.9h2v-.9z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
          </svg>
        </div>
        <div>
          <div class="m-title">「{{ feature.label }}」需要 Personal AI 扩展</div>
          <div class="m-sub">{{ feature.why }}</div>
        </div>
      </div>
      <div class="m-body">
        <label class="f-label">安装后解锁</label>
        <div class="eg-perks">
          <div
            v-for="perk in EXTENSION_PERKS"
            :key="perk.key"
            class="eg-perk"
            :class="{ here: perk.key === gate.gateFeature.value }"
          >
            <span class="pk">✓</span>
            <div>
              <b>{{ perk.title }}</b>
              <i>{{ perk.desc }}</i>
            </div>
            <span v-if="perk.key === gate.gateFeature.value" class="here-tag">当前操作</span>
          </div>
        </div>
        <label class="f-label">三步搞定</label>
        <ol class="eg-steps">
          <li>
            <span class="s-n">1</span>
            <div>
              <b>打开 Chrome 应用商店安装 Personal AI</b>
              <i>点「添加至 Chrome」，约 10 秒</i>
            </div>
          </li>
          <li>
            <span class="s-n">2</span>
            <div>
              <b>把扩展固定到工具栏，登录一次</b>
              <i>扩展用你当前浏览器的 Jira 登录态发请求，账号密码不会离开本机</i>
            </div>
          </li>
          <li>
            <span class="s-n">3</span>
            <div>
              <b>回到本页刷新</b>
              <i>检测到扩展后，锁定的按钮会自动解锁</i>
            </div>
          </li>
        </ol>
        <div class="eg-fallback">
          没有扩展也能用：<b>拖拽排期</b>、<b>草稿任务</b>、<b>人员视图</b>、<b>阶段节点 /
          外部依赖</b>、<b>分享只读或可编辑链接</b>都不受影响。
        </div>
        <div v-if="state.hasExtension.value" class="eg-ok show">
          <span>✓</span>已检测到 Personal AI 扩展，功能已解锁
        </div>
      </div>
      <div class="m-foot">
        <button class="btn btn-ghost" @click="gate.closeGate()">稍后再说</button>
        <button class="btn btn-ghost" @click="reload()">已安装好了 · 刷新页面</button>
        <button class="btn btn-primary" @click="gate.openStore()">
          前往 Chrome 应用商店
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path
              d="M4 2h6v6M10 2L3 9"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
