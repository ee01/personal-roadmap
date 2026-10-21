## 外部依赖：ETA 与期望时间分离 + 依赖视图（Demo 方案）

> 状态：**仅 Demo**（`docs/demo/roadmap-demo.html`），功能代码未改。本文记录交互判断规则，作为后续实现的依据。

### 1. 两个时间概念

| 概念 | 字段 | 谁说了算 | 来源 | 如何修改 |
|---|---|---|---|---|
| **ETA**（对方承诺） | `eta` + `etaSource: 'jira' \| 'manual'` + `etaAt` | 对方 | 绑定 ticket → 该 ticket 的 **Target End**；没有 ticket，或 ticket 没填 Target End → 手动填写对方给的日期 | **单击**节点 → 刷新（ticket）或填写（手动） |
| **期望**（我们需要） | `need`，`null` 表示与 ETA 相同 | 我们 | 默认为空；没有 ETA 时取默认值 | **拖动**节点 |
| Ticket 排期（只读镜像） | `jiraTargetStart` / `jiraTargetEnd` / `jiraStatus` | 对方 | 打开页面时静默刷新 | 不可改，只用来展示，以及判断「Jira 有变更」 |

操作习惯固定为：**拖动改我们的时间，单击改对方的时间。** 我们的时间由自己决定，所以直接拖；对方的时间只能读取或抄录，所以要单击才会改。

### 2. 派生值

```
gap  = need && eta ? diffD(need, eta) : 0     // >0：对方比我们期望的晚 gap 天
done = jiraStatus ∈ {Done, Closed, Resolved}
state =
  done                                  → 'done'     已交付
  !eta && jiraKey && jiraTargetEnd      → 'stale'    Jira 已有 Target End，待刷新
  !eta                                  → 'missing'  缺 ETA
  gap > 0                               → 'late'     晚于期望（红）
  eta ≠ jiraTargetEnd（有 ticket 时）    → 'drift'    Jira 有变更（琥珀）
  其余                                   → 'ok'       按期 / 有余量
风险排序：late < missing < stale < drift < ok < done
```

页面打开时的静默刷新**只更新镜像字段**（`jiraTargetEnd` 等），不改 `eta`。这样对方改了日期时，我们会看到 drift 提示，而不是节点自己移位。

### 3. 添加依赖

| 输入 | 行为 |
|---|---|
| 有 Jira Key，ticket 有 Target End | 自动读取：`eta = Target End`，`etaSource = 'jira'`，`need = null`。节点放在 ETA 上 |
| 有 Jira Key，ticket 没有 Target End | 等同于没有 ticket：`eta = null`。节点放在默认期望日（任务开始日，已开始的任务取今天 + 7 天） |
| 有 Jira Key，未装扩展 | 照常保存。不读取，提示稍后单击节点刷新 |
| 没有 Jira Key | 可以手动填写对方的 ETA，也可以留空。留空时节点放在默认期望日 |
| 表单里填了期望时间 | 写入 `need`（与 ETA 同一天时写入 `null`） |

### 4. 甘特上的节点（简洁版）

| eta | need | 展示 | 拖动 | 单击 |
|---|---|---|---|---|
| ✓ | 空或等于 ETA | 实心圆点在 ETA | 从圆点上拖出一个期望环，**ETA 点不动** | 打开依赖浮层，聚焦这一条 |
| ✓ | 早于 ETA | 实心红点（ETA）+ 虚线环（期望）+ **红色连线** + `+Nd` | 拖圆点或虚线环都改期望 | 同上 |
| ✓ | 晚于 ETA | 实心点 + 淡色虚线环 + 灰色点线（有余量） | 同上 | 同上 |
| ✗ | ✓ | 红色虚线环 + `?` 在期望日，角标红色脉动 | 改期望 | 填写或刷新 ETA |
| ✗ | ✗ | 不上标记轨，只显示角标 | — | — |

- **吸附合并**：期望拖到距 ETA ±1 天以内时吸附到 ETA，松手后 `need = null`，两个点合成一个。
- **多个依赖**：同一任务上多对节点共用一条标记轨。hover 某个节点时，同一依赖的另一个节点和连线高亮，其余依赖淡化。完整关系在依赖视图里看。
- 角标优先级：缺 ETA（红色脉动）> 晚于期望（红色）> Jira 有变更（琥珀）。

### 5. 依赖视图（完整版）

- 入口：工具栏「任务 / 人员 / **依赖**」。只列出**有依赖的任务**，按任务分组。组头用一条淡色任务条标出任务排期，作为上下文。
- 每个依赖一行。左侧是状态 pill、依赖内容、ticket、status 和对方团队；右侧是时间轴：
  - 上面一行是 ETA 实心点和期望虚线环。两者之间：晚于期望时用**红色半透明带 + 红线 + 「晚 Nd」**，有余量时用灰色点线 + 「余量 Nd」。
  - 下面一行是 ticket 的 Target Start → End（斜纹细条，只读）。
  - Jira 有变更时，在新的 Target End 处画一个琥珀色空心点，用虚线箭头接到当前 ETA 上。
  - 缺 ETA 时画期望环，向右接一段渐隐虚线和 `?`。
- 操作：拖动圆点或环改期望（和甘特一致，支持键盘 ← → / Shift 一次 7 天）；行内「刷新 ETA」「催一下（附上期望日期）」「接受 ETA」（期望改为跟随 ETA）。
- 过滤：全部 / 晚于期望 / 缺 ETA / Jira 有变更，计数实时更新。组内和组间都按风险排序。
- 在甘特的依赖浮层里点「在依赖视图中查看」，会跳到依赖视图并闪烁定位到这一行。

### 6. 落地改动预估（实现阶段）

- 数据：`deps[]` 增加 `need`、`etaAt`、`jiraTargetStart`。迁移时 `need = null`，即与 ETA 相同，现有数据不受影响。
- 服务端：依赖的 PATCH 接受 `need`。静默刷新只写镜像字段。
- 扩展：依赖 ticket 的读取多带回 Target Start。
- 前端：标记轨的节点渲染和拖拽拆成 ETA 点和期望环两部分，新增 `DependencyView` 组件，可以复用 `res-view` 的外壳和 sticky 表头。
