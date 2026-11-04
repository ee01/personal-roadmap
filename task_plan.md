# E-171 INIT 视角 — 生产实现任务计划

按最终 HTML demo（docs/demo/roadmap-demo.html，附件 01a1a0cb 版）+ 线程语义实现。

## Phase 1 — 数据层（server + extension）
- [x] server: migration 023 + schema.sql — items.committed, item_markers.committed, init_details 表
- [x] server: TeamService — mapItem/mapMarker committed；import op 持久化 committed + intent.inits → init_details；refresh_from_jira 镜像 committed；marker create/update committed；snapshot 暴露 inits
- [x] server: src/types.ts InitDetail / TeamSnapshot.inits
- [x] extension (personal-ai): import 读 Committed 字段 + 父 INIT 详情（title/quarter/committed）→ inits payload；refresh 带 committed
- [x] web bridge: bridgeImportJql 返回 { items, inits }；JiraRefreshIssue.committed

## Phase 2 — web 状态层
- [x] web/src/types.ts: RoadmapItem.committed, RoadmapMarker.committed, TeamSnapshot.inits, HierarchyMode, InitDetail
- [x] useRoadmapState: hierarchy/setHierarchy(localStorage tier)、initMode(默认 hide)/setInitMode、dimMode、initFold(bl/g)、ucOn/itemUc/initUc、textMatch 带上 INIT 标题、msStats.uc 计数、initInfo/initName、scopeActive、zeroHitInits、initStats、initGroups
- [x] BacklogPanel runPull: intent 带 inits

## Phase 3 — 组件
- [x] FilterBar: 层级段（左端）；「其余」按层级分开（INIT 默认 hide）；统计加 Committed: No
- [x] BacklogPanel: INIT 分组渲染（组头、计数、跨侧跳转、scope-foot、未拉取季度提示、卡片 Committed 标签、Epic 模式分组头未承诺计数）
- [x] GanttPanel: INIT 汇总行（只读覆盖条、pills、折叠、跨侧跳转、0 命中/仅 Backlog foot）；GanttRow bar 末端 Committed: No 标注 + uncommitted 虚线框
- [x] DependencyView: INIT 组头（汇总 + 共享目标分列）+ hover 显示依赖 Ticket 自身 Committed
- [x] ResourceView: INIT 层级下任务条加 INIT 前缀 + 聚焦 INIT chips（压暗其余）；INIT 层级人员视图跟随筛选
- [x] useCopyExport: INIT 层级按 INIT 分组标题行

## Phase 4 — 验证与交付
- [x] vitest 单测（server + web 新逻辑）
- [x] npm test / npm run build
- [x] 提交 main → npm run deploy → health 检查
- [x] personal-ai 构建 + 提交（提醒用户重载扩展）
