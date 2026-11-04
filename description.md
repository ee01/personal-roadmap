## User request

类似 milestone 的 Filter 实现方式，增加一个新的 Filter：**Target delivery quarter**，简称 **Quarter**。

需求整理：

1. 希望能在左上角筛选出不同 Quarter 的 Ticket。
2. 筛选之后，要展示出这个 Quarter 的 Ticket 中有没有 Target End 超出该 Quarter，并像 Milestone 一样标注出来。
3. Target Delivery Quarter 这个字段的候选列表，可以看看 JIRA 中能不能读取到。如果读取不到，可以利用当前 Quarter，往前多显示两个 Quarter，往后多显示一个 Quarter。

执行范围：整理好需求后先不用做功能开发，先在 HTML Demo 上实现这个 Filter 的效果（Quarter 筛选 + Target End 超出该 Quarter 的标注），供用户确认效果。

## Context

Milestone Filter 是本仓库（personal-roadmap）左上角已有的筛选实现，新 Filter 应参照其交互方式。Milestone 筛选时对越界（超出 Milestone）的 Ticket 已有标注样式，Quarter 筛选的 Target End 超界标注应与之保持一致。
