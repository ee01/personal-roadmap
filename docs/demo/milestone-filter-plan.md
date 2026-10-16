## Milestone 过滤：调研结论与实现计划

### 1. 调研结论（Jira Custom Labels）

| 项 | 结论 | 证据 |
|---|---|---|
| 数据结构 | Group → Label → Value 三层，都是 LBL 项目里的 issue；Value 是 sub-task | Wiki *Custom Labels User Guide* |
| 条目上的存储 | `customfield_33875`（Custom Labels）存 `LabelKey:ValueKey`，多个值以 `\n` 分隔 | `NOVA-20543` → `"LBL-288:LBL-297\nLBL-288:LBL-291"` |
| milestone 的 Label | `LBL-288` "AIR 2.0 Milestones"（Group：AI Milestones），目前 13 个 Value | `jql=parent=LBL-288` |
| milestone 日期 | **没有结构化字段**：`duedate`、Target start/end（`customfield_18350/18351`）、Planned Release Date（`customfield_23952`）全为 null。日期只写在 description 第一行 | 13 个值全部是 `Milestone: M/D/YY` 格式（`LBL-295` 写成 `Milestone - 1/31/27`） |
| 服务端过滤 | ScriptRunner JQL 可用：`issueFunction in customLabelByValue("AIR 2.0 Beta","AIR 2.0 Milestones","","no")` | 返回 91 条直接打标的 issue；第 4 个参数默认 `yes`，即沿 Product→Theme→Initiative→Epic 继承 |
| 访问权限 | Group 可以是 Restricted；不可见的 Group 不会出现在 REST 结果里 | Wiki *Key rules* |

**日期策略**：取第一个非空值：`duedate` → Target end → description 正则 `^\s*Milestone\s*[:\-–]\s*(\d{1,2})/(\d{1,2})/(\d{2,4})` → 都没有就返回 `null`，前端改为展示描述原文。这套规则能覆盖现有全部 13 个值；以后如果 LBL 的维护者开始填 Due Date，不需要改代码就能自动生效。建议推动他们填 Due Date。

### 2. 统一过滤还是两边分别做？→ 统一

一个过滤状态加一个谓词 `msMatch(item)`，Backlog、甘特（以及之后的人员视图）都从这里读：

- 问的是同一个问题："这个 milestone 下的条目都排到哪儿了？"。两边各做一套过滤，选择会不一致，用户还得选两次。
- 过滤入口放在横跨两栏的顶部行（原 QUARTERS 行），用位置本身告诉用户"这个过滤对两边都生效"。这一行只放「看什么」的视图过滤。
- Quarter 勾选 + 导入属于「拉什么数据」，是团队 JQL 的参数，移到 Backlog 标题旁的「↻ 拉取」浮层（Quarter、JQL 摘要 + 编辑入口、拉取按钮）。结果落在 Backlog，入口就放在 Backlog。
- 两边的**呈现方式**不同：
  - **Backlog**：只列出匹配的条目，和搜索框是 AND 关系，计数显示为 `2/5`。
  - **甘特**：默认把没匹配的行**淡化**，保留排期上下文，方便看出是谁在挤占时间；可以切换为**隐藏**。另外，每个选中的 milestone 画一条带日期的旗标竖线；已排期条目的结束日如果晚于它所属的 milestone，在 bar 末端标出"晚于 X Nd"。
- 多选之间是 OR 关系（命中任一即可）。选择按团队保存在 localStorage，与 rulerMode 一样只影响自己的视图。

### 3. 落地改动（本 issue 不实施）

后端 `src/`
1. `JiraClient` / 扩展桥的 refresh 字段里加上 `customfield_33875`（做成配置：`JIRA_FIELD_CUSTOM_LABELS`），解析成 `item.customLabels: {labelKey, valueKey}[]`。
2. 新增 `custom_label_values` 缓存表：`key, label_key, label_name, name, description, milestone_date, date_source, status, fetched_at`。拿到 value key 后批量执行 `key in (...)`，TTL 沿用 `JIRA_REFRESH_TTL_MS`。
3. 团队配置加一项 `milestoneLabelKey`（例如 `LBL-288`），在 JQL 设置弹窗里选择，用来决定把哪个 Label 当作 milestone 维度。
4. API：`GET /teams/:id/milestones` 返回 `{key,name,date,dateSource,description,count}`；items 接口增加 `ms: string[]`。

前端 `web/src/`
5. `useRoadmapState`：加 `msSel` 和 `msMode`，并导出 `msMatch` 与 `msLateOf`。
6. `ImportBar.vue` 改为 FilterBar，加入 MilestoneFilter（触发按钮、已选 token、淡化/隐藏开关、统计）以及选择浮层（搜索、迷你时间轴、按日期分组的列表、描述详情）。
7. `BacklogPanel.vue`：标题旁加「拉取」按钮和浮层（承接原 ImportBar 的 Quarter 与导入逻辑）；过滤列表，卡片上显示 milestone 标签；Target End 晚于 milestone 时标红。
8. `GanttPanel.vue` / `GanttRow.vue`：给行加 dim/hide 类，画 milestone 旗标线，显示"晚于"徽标。
9. `ResourceView.vue`（第二期）：把不属于所选 milestone 的 Epic 下的任务压暗。

待确认
- 子任务（Task）有没有自己的 `customfield_33875`？当前只按 Epic 判定，子任务跟随父 Epic。
- 是否需要 Initiative 继承？如果需要，用 JQL 函数 `useInheritance=yes` 做服务端过滤，不在前端走层级。
