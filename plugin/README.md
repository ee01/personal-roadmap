# Personal Roadmap Codex Plugin

把 Draft 规划 MCP 与 Skill 打成可从 Git/local marketplace 安装的单元。在 Codex 里的显示名是 **Personal Roadmap**，用户在新对话里 `@` 这个名字即可使用。不读取 Chrome Jira token，不调用 Memory Service，不创建 Jira。

目录 id 仍是 `roadmap-planning`，已有 marketplace 条目不用改路径。要 mention 的是显示名，不是这个 id。

## 安装之后怎么用

Codex 没有单独的安装完成向导，也不能在安装表单里收集团队 token。绑定团队用插件里的 **Roadmap Setup**。

1. 插件列表应显示 **Personal Roadmap**。若仍是旧名 Roadmap Planning，更新或重装（清单版本 `1.2.1`）。
2. **新开一个** Codex 对话。已经打开的对话不会自动带上刚安装的插件。
3. 还没绑定团队时，输入 `$roadmap-setup`，或在技能列表里选择 **Roadmap Setup**。按提示粘贴可编辑分享链接（团队 id + `rw_` token）。凭证写在本机 `~/.codex/personal-roadmap.json`，不要提交。
4. 再输入 `@`，选择 **Personal Roadmap**，粘贴需求、会议纪要或 Markdown。也可以点详情里的示例提示。
5. 之后任何规划、列出、删除或退回 Backlog，只要还没 Setup，都会先停下来引导去 Roadmap Setup，不会直接改 Roadmap。
6. 结果是 Roadmap 上的 Draft 和初排甘特，不会创建 Jira。换团队就再走一次 Setup。

用户若在 Codex 里信任了插件 hook，新会话和 `roadmap_*` 工具调用在未 Setup 时也会被拦去 Setup。没信任 hook 时，Skill 和 MCP 的返回值同样会引导。

## 安装

两条路，任选其一（都只生成 Draft，不创建 Jira）。**普通用户请走远程 MCP，不必克隆本仓库。**

1. **给 AI Agent 安装 Skill（推荐）**：把 GitHub `SKILL.md` 或 `http://roadmap.xmnup.com/skills/roadmap-planning/SKILL.md` 交给 Agent。安装不会弹出 Token 表单。第一次使用时，Agent 按 Skill 请用户粘贴顶栏「分享可编辑链接」，把 `X-Team-Id` 和 `X-Share-Token` 写入该宿主的 MCP 配置（Cursor 的 `mcp.json`、Claude 的 `.mcp.json`，或未装本插件时的 Codex `config.toml`）。远程 MCP 默认 `http://roadmap.xmnup.com/mcp`。不要在这条路上运行 `$roadmap-setup`。
2. **Codex Plugin 导入**：在 Codex / ChatGPT 桌面的 Plugins 里导入 marketplace。仓库填 `https://github.com/ee01/personal-roadmap`，Path `.`，Branch `main`，安装显示名为 **Personal Roadmap** 的插件。装好后用 **Roadmap Setup** 写入团队 token，不要手改 `config.toml`。

本地 stdio 仅作后备（不经过插件桥时）：

1. 构建 MCP：`npm --prefix mcp run build`
2. 配置环境变量（宿主安全存储，不要写进仓库）：

```bash
ROADMAP_BASE_URL=https://your-roadmap
ROADMAP_TEAM_ID=...
ROADMAP_EDIT_TOKEN=...
```

3. 新会话应发现插件 **Personal Roadmap**、技能 **Roadmap Setup**（id 分别是 `roadmap-planning`、`roadmap-setup`）与 MCP tools。

## 验收边界

- 干净环境无 `../../memory-service` import
- 工具列表不含 Jira create；含 `roadmap_list_items` / `roadmap_delete_item` / `roadmap_unschedule_item` / `roadmap_add_item`
- validate → commit → receipt 可在脱离 monorepo 后走 HTTP API 完成
- 不承诺官方公开目录上架
