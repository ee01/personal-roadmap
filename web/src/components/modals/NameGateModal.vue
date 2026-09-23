<script setup lang="ts">
import { ref } from 'vue';
import { useRoadmapState } from '../../composables/useRoadmapState';

const state = useRoadmapState();
const name = ref('');

function save() {
  if (!name.value.trim()) return;
  state.api.setActorName(name.value.trim());
  state.nameGateOpen.value = false;
}
</script>

<template>
  <div
    class="modal-back"
    :class="{ show: state.nameGateOpen.value }"
    @click.self.prevent
  >
    <div class="modal" style="width: 420px">
      <div class="m-head">
        <div class="m-title">请输入你的名字</div>
        <div class="m-sub">
          未检测到 Personal AI 扩展时需要手动填写；已安装扩展会自动读取 Glip
          身份。名称会保存在本浏览器中。
        </div>
      </div>
      <div class="m-body">
        <label class="f-label">显示名称</label>
        <input
          v-model="name"
          class="f-input"
          placeholder="例如：Esone Qiu"
          @keydown.enter="save"
        />
      </div>
      <div class="m-foot">
        <button class="btn btn-primary" @click="save">继续</button>
      </div>
    </div>
  </div>
</template>
