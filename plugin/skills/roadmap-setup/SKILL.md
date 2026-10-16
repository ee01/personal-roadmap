---
name: roadmap-setup
description: >
  为 Personal Roadmap 写入当前团队的 id 和可编辑分享 token。
  用户要 Setup、配置团队、填写 token，或任何 Roadmap 命令还没有绑定团队时使用。
  在 Codex 里用 $roadmap-setup（显示名 Roadmap Setup）调用。
  配好之前不要调用 roadmap_*，不要编造 token，不要创建 Jira。
---

# Roadmap Setup

把**一个团队**的写入凭证存到本机。一个 token 只对应一个团队。换团队就再走一遍，新的覆盖旧的。

凭证写在 Codex 本机配置目录的 `personal-roadmap.json`（不要提交、不要写进仓库、不要在回复里复述 token）。插件的 MCP 每次调用都会重新读这个文件，写完后当前对话里的下一步就可以用。

## 什么时候必须走这里

Personal Roadmap 的任何操作都先看有没有 Setup：新建 Draft、预览、列出甘特或 Backlog、删除、退回 Backlog、撤销。没有凭证就停在这一步，不要先做用户原来的那件事。

## 用户要准备的材料

用户得已经能编辑这个团队（创建者，或从可编辑链接进来的人）。只读打开时没有 token。

1. 地址栏 `?team=` 后面是团队 id。
2. 顶栏「分享可编辑链接」。复制出来的地址里 `token=` 后面就是写入凭证，以 `rw_` 开头。每次分享会新发一个，之前发出去的仍然有效。只读链接没有 `token`，不能拿来写。
3. 自建站点才需要另外给地址。默认是 `http://roadmap.xmnup.com`。

可以让用户直接粘贴整段可编辑链接，不必拆开。

## 步骤

1. 找到本插件根目录（含 `skills/` 与 `scripts/`）。脚本是 `scripts/setup.mjs`，相对这份 Skill 是 `../../scripts/setup.mjs`。只有这份 Markdown、找不到脚本时，不要假装已经写入；改用宿主自己的 MCP 配置，加上 `X-Team-Id` 和 `X-Share-Token`。
2. 运行 `node <插件根>/scripts/setup.mjs status`。标准输出是 JSON，里面没有 token。
   - `configured: true`：告诉用户当前团队 id（不要提 token），问是沿用还是换团队。沿用就结束。
   - `configured: false`：进入下一步。`error` 为 `invalid_json` 时说明旧文件损坏，直接覆盖。
3. 向用户要可编辑链接，或团队 id + token。不要编造，不要用只读链接。
4. 把 JSON 从标准输入传给脚本，不要把 token 放进命令行参数：

```bash
node <插件根>/scripts/setup.mjs apply <<'EOF'
{"url":"<用户粘贴的可编辑链接>"}
EOF
```

分开给时用 `{"teamId":"...","token":"..."}`。自建站点加 `"baseUrl":"https://你的站点"`。

5. 再跑一次 `status`。只有 `configured: true` 才算完成。失败时把脚本的错误说明给用户，不要回显 token。
6. 完成后可以继续用户原来的 Personal Roadmap 请求。回复里只确认团队 id，不确认 token 全文。

## 其他宿主

Cursor 等没有这个插件桥时，把同一组 headers 写进该宿主的 MCP 配置（远程 URL 默认 `http://roadmap.xmnup.com/mcp`）。不要把 token 写进 Skill 或仓库。
