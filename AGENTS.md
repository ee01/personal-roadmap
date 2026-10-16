# Agent 工作约定

## 功能完成后自动部署

一个**完整功能**在 `main` 上完成后，直接部署到 Mac mini，不需要再问：

1. `npm test` 和 `npm run build` 都通过
2. 改动已提交到 `main`
3. 执行 `npm run deploy`
4. 在最终回复里写明部署结果：health 检查是否通过、迁移是否执行、新接口是否可用

以下情况**不部署**：只改了文档或 `docs/demo/` 原型；功能只做了一部分；测试或构建没通过；改动还在任务分支上，没有合进 `main`。

部署失败时不要反复重试，把报错原文贴在回复里。

## 服务器

地址已经写死在 `tools/deploy.mjs` 中，可以用环境变量或参数覆盖：

| 项 | 值 | 覆盖方式 |
|---|---|---|
| 主机（Mac mini） | `rcadmin@10.32.56.212` | `ROADMAP_DEPLOY_HOST` / `--host` |
| 部署目录 | `/Users/rcadmin/personal-roadmap` | `ROADMAP_DEPLOY_PATH` / `--remote-dir` |
| 容器 / 端口 | `roadmap-service` / `3220` | — |
| Health | 在服务器上执行 `curl http://127.0.0.1:3220/health` | — |
| 公网地址 | `http://roadmap.xmnup.com` | — |

`npm run deploy` 依次执行：本地构建 → rsync（不同步 `.env`、`data/`）→ 在服务器上 `docker compose build` 并重建容器 → 等待 health 通过。数据库迁移在服务启动时自动执行。

## 涉及 Chrome 扩展时

扩展代码在 `personal-ai` 仓库（例如 `contentScriptRoadmap.ts`），**不会**部署到服务器。在那边构建并提交即可，然后提醒用户去 `chrome://extensions` 重新加载扩展。
