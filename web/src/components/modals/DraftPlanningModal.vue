<script setup lang="ts">
import { reactive } from 'vue';
import { CURQ } from '../../composables/useGeometry';
import { useDraftPlanning } from '../../composables/useDraftPlanning';
import {
  ROADMAP_PLANNING_GITHUB_REPO,
  ROADMAP_PLANNING_LIVE_SKILL_URL,
  ROADMAP_PLANNING_MARKETPLACE_PATH,
  ROADMAP_PLANNING_MARKETPLACE_REF,
  ROADMAP_PLANNING_MCP_HTTP_URL,
  ROADMAP_PLANNING_SKILL_URL,
} from '../../composables/usePlanningAgentLinks';
import { useRoadmapState } from '../../composables/useRoadmapState';

defineProps<{
  embedded?: boolean;
}>();

const state = useRoadmapState();
const planning = reactive(useDraftPlanning());

const quarterOptions = () => {
  const checked = state.snapshot.value?.team.checkedQuarters || [];
  return checked.includes(CURQ) ? checked : [CURQ, ...checked];
};
</script>

<template>
  <div class="dp-root">
    <div v-if="planning.phase === 'committed' && planning.receipt" class="dp-result">
      <div class="dp-result-title">已创建 Draft，尚未创建 Jira</div>
      <p class="dp-result-body">
        新增 {{ planning.receipt.createdParents.length }} 个主任务、{{
          planning.receipt.createdChildren.length
        }}
        个子任务；复用 {{ planning.receipt.attachedParents.length }} 个已有主任务。
      </p>
      <p v-if="planning.receipt.warnings.length" class="dp-note">
        {{ planning.receipt.warnings.map((item) => item.message).join('；') }}
      </p>
      <p class="dp-note">
        接下来到甘特条点「创建 Jira」（需要 Personal AI 扩展）。MCP / Skill 只生成 Draft，不会创建 Jira。
      </p>
      <p class="dp-note">
        「撤销本批」会撤回这次生成的 Draft。已经回填了 Jira key 的条目会留下，也不会从 Jira 删票。
      </p>
      <div class="dp-result-actions">
        <button class="btn btn-ghost" :disabled="planning.undoing" @click="planning.undo()">
          {{ planning.undoing ? '撤销中…' : '撤销本批' }}
        </button>
      </div>
    </div>

    <template v-else>
      <label class="f-label">需求</label>
      <textarea
        v-model="planning.text"
        class="f-input f-desc dp-input"
        :disabled="planning.busy"
        placeholder="粘贴需求、会议纪要或 Markdown；已分 Epic 或尚未分组均可"
      />
      <div class="dp-meta">
        <span>{{ planning.charCount }} / {{ planning.maxChars }}</span>
        <span>{{ state.snapshot.value?.team.name }} · {{ planning.quarter || '当前季度' }}</span>
      </div>
      <div class="dp-disclose">{{ planning.disclosure }}</div>
      <div class="dp-ways">
        <div class="dp-ways-title">要用自己的 Agent 生成 Draft，任选一种（都不会创建 Jira）</div>
        <div class="dp-way">
          <div class="dp-way-name">1. Codex Plugin 导入</div>
          <p>
            打开 Codex / ChatGPT 桌面的 Plugins → 导入 marketplace，仓库填
            <a :href="ROADMAP_PLANNING_GITHUB_REPO" target="_blank" rel="noopener">{{ ROADMAP_PLANNING_GITHUB_REPO }}</a>
            ，Path <code>{{ ROADMAP_PLANNING_MARKETPLACE_PATH }}</code>，Branch
            <code>{{ ROADMAP_PLANNING_MARKETPLACE_REF }}</code>，再安装
            <code>roadmap-planning</code>。
          </p>
        </div>
        <div class="dp-way">
          <div class="dp-way-name">2. 给 AI Agent 安装 Skill</div>
          <p>
            把
            <a :href="ROADMAP_PLANNING_SKILL_URL" target="_blank" rel="noopener">GitHub 上的 Skill</a>
            或
            <a :href="ROADMAP_PLANNING_LIVE_SKILL_URL" target="_blank" rel="noopener">线上 Skill</a>
            交给 Agent，不必下载源码。远程 MCP 默认
            <code>{{ ROADMAP_PLANNING_MCP_HTTP_URL }}</code>
            ，自建站点则改成你的
            <code>/mcp</code>
            。首次需要填团队
            <code>X-Team-Id</code>
            和可编辑
            <code>X-Share-Token</code>
            。
          </p>
        </div>
      </div>
      <p v-if="planning.overLimit" class="dp-error">输入超出上限，请拆分后再提交</p>

      <button type="button" class="dp-adv-toggle" @click="planning.advancedOpen = !planning.advancedOpen">
        {{ planning.advancedOpen ? '收起高级选项' : '高级选项' }}
      </button>
      <div v-if="planning.advancedOpen" class="dp-adv">
        <div class="f-grid">
          <div>
            <label class="f-label">规划起点</label>
            <input
              v-model="planning.planningStart"
              class="f-input"
              type="date"
              :disabled="planning.busy"
            />
          </div>
          <div>
            <label class="f-label">目标季度</label>
            <select v-model="planning.quarter" class="f-input" :disabled="planning.busy">
              <option value="">不指定</option>
              <option v-for="q in quarterOptions()" :key="q" :value="q">{{ q }}</option>
            </select>
          </div>
        </div>
        <label class="f-label">挂到指定主任务（item key，逗号分隔）</label>
        <input
          v-model="planning.parentKeys"
          class="f-input"
          :disabled="planning.busy"
          placeholder="留空则允许模型按唯一标题复用；否则只挂到这些主任务"
        />
        <p class="f-note">粘贴的链接只保存为引用，不会自动抓取网页内容。</p>
      </div>

      <div v-if="planning.busy" class="dp-progress">
        <span class="spinner" />
        <span>{{ planning.phaseLabel(planning.phase) }}</span>
        <button class="btn btn-ghost" type="button" @click="planning.cancel()">取消</button>
      </div>
      <p v-else-if="planning.phase !== 'idle' && planning.phaseLabel(planning.phase)" class="dp-phase">
        {{ planning.phaseLabel(planning.phase) }}
      </p>
      <p v-if="planning.errorText" class="dp-error">{{ planning.errorText }}</p>

      <div v-if="planning.phase === 'needs_input'" class="dp-issues">
        <div v-for="issue in planning.issues" :key="issue.decisionId || issue.code + issue.message" class="dp-issue">
          <div class="dp-issue-msg">{{ issue.message }}</div>
          <div v-if="issue.decisionId && issue.options?.length" class="dp-opts">
            <button
              v-for="opt in issue.options"
              :key="opt.id"
              type="button"
              class="exec-opt"
              :class="{ on: planning.decisions[issue.decisionId] === opt.id }"
              @click="planning.decisions[issue.decisionId!] = opt.id"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <button class="btn btn-primary" type="button" @click="planning.commitPreview()">按选择创建 Draft</button>
      </div>

      <div v-else-if="planning.phase === 'ready' && planning.preview" class="dp-preview">
        <div class="dp-result-title">{{ planning.preview.documentTitle || '预览' }}</div>
        <div v-for="parent in planning.preview.parents" :key="parent.ref" class="ai-group">
          <div class="ai-row parent">
            <span class="t">{{ parent.action === 'attach' ? '复用' : '新建' }} · {{ parent.title }}</span>
            <span class="st">{{ parent.children.length }} 个子任务</span>
          </div>
          <div v-for="child in parent.children" :key="child.title" class="ai-row child">
            <span class="child-mark">└</span>
            <span class="t">{{ child.title }}</span>
            <span class="st">{{ child.owner || child.ownerCandidates.join(' / ') || '待分配' }}</span>
          </div>
        </div>
        <button class="btn btn-primary" type="button" @click="planning.commitPreview()">创建这些 Draft</button>
      </div>
      <div v-if="planning.phase !== 'needs_input' && planning.phase !== 'ready' && !planning.busy" class="dp-actions">
        <label class="dp-check dp-check-inline">
          <input v-model="planning.autoCommit" type="checkbox" :disabled="planning.busy" />
          直接创建 Draft
        </label>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="planning.busy || !planning.text.trim() || planning.overLimit || !planning.llmReady"
          @click="planning.generate()"
        >
          {{ planning.autoCommit ? '生成并创建 Draft' : '生成预览' }}
        </button>
      </div>
    </template>
  </div>
</template>
