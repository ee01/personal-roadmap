<script setup lang="ts">
import { ref } from 'vue';
import { EXTENSION_STORE_URL } from '../composables/useExtensionGate';
import {
  ROADMAP_PLANNING_GITHUB_REPO,
  ROADMAP_PLANNING_LIVE_SKILL_URL,
  ROADMAP_PLANNING_MARKETPLACE_PATH,
  ROADMAP_PLANNING_MARKETPLACE_REF,
  ROADMAP_PLANNING_MCP_HTTP_URL,
  ROADMAP_PLANNING_SKILL_URL,
} from '../composables/usePlanningAgentLinks';

const open = ref(false);
</script>

<template>
  <button class="help-fab" @click.stop="open = !open">?</button>
  <div class="help-pop" :class="{ show: open }">
    <h4>使用说明</h4>
    <ul>
      <li>
        <b>使用 AI 批量创建</b>：新建条目弹窗可粘贴需求，由 Roadmap 服务端生成 Draft 主任务/子任务并初排甘特；不创建 Jira。默认只预览，勾选「直接创建 Draft」才一次写入。无扩展也能用。创建 Jira 仍走原弹窗，且需要扩展。
      </li>
      <li>
        <b>用自己的 Agent 生成 Draft</b>有两条路（都不会创建 Jira）：① Codex Plugin 导入 marketplace，仓库
        <a class="help-install" :href="ROADMAP_PLANNING_GITHUB_REPO" target="_blank" rel="noopener">{{ ROADMAP_PLANNING_GITHUB_REPO }}</a>
        ，Path <code>{{ ROADMAP_PLANNING_MARKETPLACE_PATH }}</code>，Branch
        <code>{{ ROADMAP_PLANNING_MARKETPLACE_REF }}</code>，再装 <code>roadmap-planning</code>；② 把
        <a class="help-install" :href="ROADMAP_PLANNING_SKILL_URL" target="_blank" rel="noopener">GitHub Skill</a>
        或
        <a class="help-install" :href="ROADMAP_PLANNING_LIVE_SKILL_URL" target="_blank" rel="noopener">线上 Skill</a>
        交给 Agent，远程 MCP 默认
        <a class="help-install" :href="ROADMAP_PLANNING_MCP_HTTP_URL" target="_blank" rel="noopener">{{ ROADMAP_PLANNING_MCP_HTTP_URL }}</a>
        ，不必下载源码。
      </li>
      <li>
        <b>导入 / 创建 Jira / 读取 ETA / 回写 Jira 需要 Personal AI 扩展</b>：未安装时锁定按钮点击可查看安装指引；拖动排期或改 Owner 会先保存在 Roadmap，并出现一行「没有同步到 Jira」提示
        <a class="help-install" :href="EXTENSION_STORE_URL" target="_blank" rel="noopener">前往安装 ↗</a>
      </li>
      <li>Bar 可<b>拖动 / 左右把手伸缩 / 上下换行</b>，按天吸附</li>
      <li><b>单击 bar 展开/收起</b>；草稿双击<b>改任务名</b>（可折叠填描述，Shift+Enter 展开；创建 Jira 用），已创建的双击改备注名（子任务可改 Owner）</li>
      <li>已导入 / 草稿子任务均可 <b>× 从 Roadmap 移除</b>（可再导入）</li>
      <li>有 Jira key 时：hover 左上 <b>↗</b> 或 <b>⌘/Ctrl+单击</b> 打开 Jira</li>
      <li>添加任务：左侧头像点选，或标题里输入 <b>@</b> 指定 Owner（可选）；默认从今天起两周；描述可选，不挡 Enter 秒建</li>
      <li>创建 Jira 可配置 <b>Assignee 映射</b>（系统名 → Firstname Lastname）</li>
      <li>悬浮：bar <b>左侧 ＋ 添加任务</b>，<b>右侧 ◆＋ 阶段节点/外部依赖</b>，<b>右上角 × 退回 Backlog</b></li>
      <li><b>阶段节点</b>与有 ETA 的依赖落在标记轨；缺 ETA 时红色 🔗 角标持续提醒。绑定了 Jira 的依赖：浮层里点 key 打开 Jira，点「未刷新」旁的 ↻ 刷新 status / Target End；hover 只读，单击才确认是否把 Target End 写成 ETA</li>
      <li>装了扩展时，打开 Roadmap 会<b>静默刷新</b>甘特上非草稿票的 summary / description / Target / assignee，以及依赖 ticket 的 status / Target End（10 分钟内不重复；依赖 ETA 不会被自动改写）</li>
      <li>装了扩展时，非草稿主/子任务拖动会回写 Jira Target，子任务改 Owner 会回写 assignee（需映射；清空会确认）。未装扩展时这两类改动只留在 Roadmap</li>
      <li><b>人员视图</b>：按人查看任务（近 2 周 / 全部）；双击改名、添加/移除空闲成员。任务条<b>左侧色条 + 前缀 chip</b>标识所属主任务（条太窄只留色条）</li>
      <li><b>时间轴缩放</b>：触控板<b>双指捏合</b>或 <b>⌘+滚轮</b>在甘特任意位置缩放，光标下的日期钉住；顶部<b>时间标尺上双指上下滑动</b>同样缩放；<b>双击标尺</b>复位 100%，再双击 = 整条时间轴收进视口</li>
      <li><b>聚焦当前任务（人员视图）</b>：<b>单击任务条</b>标记「正在做」（可多选）；点另一人则换人重选。<b>「其余延至下周 →」</b>把其余未完成、下周前开始的任务滑到下周一开始（长度不变，受 Epic 结束日钳制；hover 预览落点）。Esc / 点空白退出</li>
      <li><b>人员视图时间窗平移</b>：近 2 周模式下<b>双指左右滑动</b>整窗平移，或点两端「更早 / 更晚」；平移后可<b>回到今天</b></li>
      <li><b>创建 Jira 后草稿名保留为备注名</b>：回传 key 时把原草稿标题存为备注名。编辑备注名时<b>清空后回车 = 恢复原 ticket 名</b></li>
      <li><b>清理过期</b>：过期 Epic 回退 Backlog；过期子任务标记清理（可再拖回还原）</li>
      <li><b>发布时间表标尺</b>：✎ 弹窗可配置 Google Sheet（Release / Phase / Date）；可用 Release 过滤去掉小版本；保存后主标尺换成发布 Sprint，工具栏可临时切回月份</li>
      <li>顶栏只列出<b>本机已知团队</b>（创建 / 分享链接 / 地址栏打开过的）；只读团队带眼睛图标。可<b>分享可编辑链接</b>或<b>只读链接</b>（无 token）</li>
      <li>颜色按「当前月」区分过去 / 当前 / 未来</li>
    </ul>
  </div>
</template>
