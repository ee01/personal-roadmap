---
name: roadmap-planning
description: >
  把需求变成 Personal Roadmap 的 Draft 主任务/子任务与初排甘特。
  用户把本文件的 GitHub / 线上 URL 交给 Agent 即可安装，不必克隆仓库、不必运行本地 node。
  默认远程 MCP：http://roadmap.xmnup.com/mcp
  在用户要「根据需求建 Roadmap Draft / Epic / Ticket 排期」且目标是该团队的 Roadmap 时使用。
  不创建 Jira，不读取 Memory，不签发分享链接。
---

# Roadmap Draft 规划

合同版本 `1.0.0`，schema `1`。不兼容时在花费服务端 LLM 或写入 Draft 前拒绝，不要静默丢字段。

## 安装（不用下载源码）

把**本 Markdown**交给 Agent（GitHub blob、raw，或 `http://roadmap.xmnup.com/skills/roadmap-planning/SKILL.md`）。

然后给宿主加一个**远程 MCP**（Streamable HTTP），不要填本地 `node …/mcp/dist/index.js`：

| | 默认 | 自建 |
|---|---|---|
| MCP URL | `http://roadmap.xmnup.com/mcp` | `{你的 Roadmap 站点}/mcp` |

Headers（问用户一次，写进 MCP 配置，不要写进本 Skill、不要提交）：

- `X-Team-Id`：Roadmap 地址栏 `?team=` 后面那段
- `X-Share-Token`：可编辑分享链接里的 token（也可用 `Authorization: Bearer <token>`）

Cursor 示例（`~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "roadmap-planning": {
      "url": "http://roadmap.xmnup.com/mcp",
      "headers": {
        "X-Team-Id": "<team id>",
        "X-Share-Token": "<edit token>"
      }
    }
  }
}
```

Claude / Codex 同样填 **url + headers**，不要配 `command`/`args`。新开会话后应出现 `roadmap_get_context` 等工具。

自建 Roadmap 时把 URL 改成你的站点；**不改就用** `http://roadmap.xmnup.com/mcp`。

## 触发

- 用户要把需求/纪要/Markdown 变成 Roadmap Draft。
- 用户要复用已有主任务并只加子任务。
- 用户只要「整理建议 / 预览」，不要直接写入。

## 步骤

1. 若还没有 `roadmap_*` 工具：按上面把远程 MCP 配好，再继续。缺 team / token 时向用户要，不要编造。
2. 调用 `roadmap_get_context`，核对 contract/schema 与团队父项、成员。
3. 只用用户授权的文档。链接原文未读取时明确说明「只保存引用」。
4. 用宿主模型产出 `DraftPlanV1`：两级 parents/children；保留 Overall 背景、里程碑、风险、待确认项、多人 Owner 候选、TBD。
5. `roadmap_validate_plan`。`needs_input` 时向用户集中询问，再 `roadmap_revise_plan`。
6. 用户已经明确要求创建 Draft 且范围一致 → `roadmap_commit_plan`（固定 revision/hash/requestId）。
   用户只要分析/建议 → 不要 commit。
7. 网络超时用同一个 `requestId` 调 `roadmap_get_request`，不要换新 id 盲重试。
8. 返回不含 token 的 Roadmap 链接、警告、待分配 Owner。创建 Jira 请有扩展的用户在 Roadmap「创建 Jira」完成。

## 列出、单条删除、退回 Backlog

安装后若用户要改已有条目，**不要再说「MCP 目前只有整批撤销，没有单条删除」**。用下面的工具：

| 要做的事 | 工具 | 说明 |
|---|---|---|
| 区分甘特 vs Backlog | `roadmap_list_items` | `view=gantt` 只看已排期；`view=backlog` 只看未排期；默认 `all` 同时返回 `gantt` / `backlog` 两个数组。`roadmap_get_context` 的每条 item 也带 `view` |
| 永久删除一条 Draft 主任务 | `roadmap_delete_item` | 只删 **没有 Jira key** 的 Draft 父项及其子任务。不删 Jira 票。已写成 Jira 的条目会拒绝 |
| 从甘特拿掉、放到 Backlog | `roadmap_unschedule_item` | 等同网页右上角 ×「退回 Backlog」。条目还在，只是 `scheduled=false`。Draft 和已有 Jira 的都可以 |
| 整批撤销刚才 AI 写入的 Draft | `roadmap_undo_batch` | **仍然只做整批**。不要拿它删单条 |

`roadmap_get_context` 也可传 `view=gantt\|backlog` 过滤。

## 保真

- 不要把「Jimmie / Fairy」收成单人 Owner；TBD 保持未分配。
- 不要编造 Jira key、数据库 ID 或成员。
- 不要调用任何 Jira create / Memory 工具。
- attach 已有父项时默认只加子任务，不改父标题/Jira/非空描述。

Schema 详见 [references/plan-schema.md](references/plan-schema.md)。
