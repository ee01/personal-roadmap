# Personal Roadmap Service

团队排期看板（Gantt）后端 + Vue 前端。默认公共站点：`http://roadmap.xmnup.com`。

## 何时自托管

Roadmap 存的是**团队协作数据**（team、share token、activity），粒度是 per-team / per-org，不是 per-user。常见原因：

- `.env` 里的 `JIRA_PAT` 是组织级凭据，不宜放在第三方公共服务器
- 内网隔离 / 合规要求

个人隐私数据请走 Personal AI 仓库里的 Memory Service 自托管（`docs/self-hosting-memory-service.md`）。

## Docker Compose

```bash
cp .env.example .env
# 编辑 JIRA_BASE_URL / JIRA_PAT（可选，用于 Target 回写 fallback）
npm run build
docker compose up -d
curl http://localhost:3220/health
```

默认端口 `3220`。

## 连接 Chrome 扩展

1. Options →「项目 Roadmap」→ 填你的站点地址（如 `https://plan.acme.com`）
2. 保存后扩展会动态注册 content script
3. **刷新 Roadmap 页面**；桥接脚本按配置的 hostname 注入（不再要求域名含 `roadmap` 字样）

Memory Service 地址与 Roadmap 地址互不影响，两边服务端都**不需要**登记对方域名。

## 部署到 Mac mini

```bash
npm run deploy
```

默认同步到 `rcadmin@10.32.56.212:/Users/rcadmin/personal-roadmap`，用本仓库的 `docker-compose.yml` 重建容器。容器名仍是 `roadmap-service`，端口仍是 `3220`，所以 `roadmap.xmnup.com` 不用改。部署前会删掉同名的旧容器，不会再起第二个。

第一次部署时，如果新目录还没有 `.env` 或 `data/`，脚本会从 `/Users/rcadmin/personal-ai/roadmap-service` 拷过来。之后不再覆盖这两处。脚本不会把 `.env` 从本机传上去。

本机独立部署用上面的 Docker Compose，不依赖 Personal AI 仓库。

## 文档

- 功能说明仍在 Personal AI 仓库：`docs/features/personal_roadmap.md`
- 静态 Demo 仍在 Personal AI 仓库：`docs/demo/roadmap-demo.html`

## AI 批量规划 Draft

产品内入口：Backlog「新建条目 → 使用 AI 批量创建」。服务端调用 OpenAI 或 Claude 生成两级 Draft 并初排甘特，**不创建 Jira**。远程 MCP：`GET/POST /mcp`，默认 `http://roadmap.xmnup.com/mcp`。弹窗在「要用自己的 Agent 生成 Draft」处并列 Codex Plugin 导入与把 GitHub/线上 Skill 交给 Agent（不必下载源码）。

1. 复制 `.env.example` 后按需填写 `ROADMAP_OPENAI_API_KEY` 或 `ROADMAP_CLAUDE_API_KEY`
2. `ROADMAP_AI_ENABLED=true` 才打开网页「生成」；关掉时手动创建和 MCP `validate/commit` 仍可用
3. 网页「生成」旁勾选「直接创建 Draft」才一次写入，默认只预览（不再用服务端 `ROADMAP_AI_AUTO_COMMIT`）
4. 生成成功后可「撤销本批」，没有 `ROADMAP_AI_UNDO_ENABLED`；已经回填 Jira key 的条目会留下
5. Base URL 只允许部署管理员改，不能由请求或需求正文覆盖

Agent 入口：

- MCP：[`mcp/README.md`](mcp/README.md)
- Codex Plugin：[`plugin/README.md`](plugin/README.md)

```bash
npm --prefix mcp run build
```
