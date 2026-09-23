# Roadmap Planning Codex Plugin

把 `roadmap-planning` MCP 与 Skill 打成可从 Git/local marketplace 安装的单元。不读取 Chrome Jira token，不调用 Memory Service，不创建 Jira。

## 安装

两条路，任选其一（都只生成 Draft，不创建 Jira）。**普通用户请走远程 MCP，不必克隆本仓库。**

1. **给 AI Agent 安装 Skill（推荐）**：把 GitHub `SKILL.md` 或 `http://roadmap.xmnup.com/skills/roadmap-planning/SKILL.md` 交给 Agent。远程 MCP 默认 `http://roadmap.xmnup.com/mcp`，自建则改成 `{站点}/mcp`。Headers：`X-Team-Id`、`X-Share-Token`。
2. **Codex Plugin 导入**：在 Codex / ChatGPT 桌面的 Plugins 里导入 marketplace。仓库填 `https://github.com/ee01/personal-roadmap`，Path `.`，Branch `main`，再安装 `roadmap-planning`。Plugin 里的本地 stdio MCP 仍可能要另配；优先用上面的远程 URL。

本地 stdio 仅作后备：

1. 构建 MCP：`npm --prefix mcp run build`
2. 配置环境变量（宿主安全存储，不要写进仓库）：

```bash
ROADMAP_BASE_URL=https://your-roadmap
ROADMAP_TEAM_ID=...
ROADMAP_EDIT_TOKEN=...
```

3. 新会话应发现 Skill `roadmap-planning` 与 MCP tools。

## 验收边界

- 干净环境无 `../../memory-service` import
- 工具列表不含 Jira create；含 `roadmap_list_items` / `roadmap_delete_item` / `roadmap_unschedule_item`
- validate → commit → receipt 可在脱离 monorepo 后走 HTTP API 完成
- 不承诺官方公开目录上架
