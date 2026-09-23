import type { DraftPlanV1 } from '../../planning/contracts.js';

export const E12_SOURCE = `# AI Service — Nova Agent 接入 Contact Center Epics

Overall 背景：Steve 打算让团队 E2E 地对整个功能负责（Nova 侧），IVR / Telco 仍由 Troy 团队负责。新做的功能需要考虑如何和 Air 2.0 串联。Week 1 目标：先基于现有后端跑起来，识别问题。当前无 PM 支持。

里程碑：Week 1 9.15-9.19；RingCX ~10.16；RCCC ~10.30；总截止 ~11.30。
风险：PM 聚焦 10.22 的 2.0 版本。

## Epic 1: AIR as virtual assistant in RCCC - Inbound Voice
将 Nova Agent 接入 RCCC Inbound Voice。外部来电 → IVR 路由 → RCCC 转接 Nova Agent → 多轮对话 → 无法解决时 handoff。
关键待确认项不要改写成已选择某一路。

### Tickets
1. [RCCC Inbound] Voice + Handoff 接入 — Zack。依赖环境 ready：Tail 组件部署到 Nova 环境。参考 https://wiki.ringcentral.com/x/_14kQw
2. [RCCC Inbound] Air 与 RingEX 解耦 — Zack
3. [RCCC Inbound] 开发 & Regression 环境搭建 — Barry。Tail 部署到 Lab01/Lab02/INT。
4. [RCCC] AuditLog 审计日志对接 — Bernard。约 1 人天。

## Epic 2: AIR as virtual assistant in RCCC - Outbound Voice
主动外呼：NOCC → NOA 编排 → Telco/Tail 拨出 → 接通后 Inbound 回流。Kasni 已有 design。RCCC 已有 demo（除 handoff 外已跑通）。
关键待确认项：Outbound 拨出走 RCCC 平台能力还是我方 Telco 直拨。

### Tickets
1. [RCCC Outbound] Voice + Handoff 接入 — Dylan
2. [RCCC Outbound] 需求确认：拨出走 RCCC 还是 Telco — Dylan
3. [RCCC Outbound] 现有 Demo 验证 & Gap 识别 — Dylan

## Epic 3: AIR as virtual assistant in RingCX
接入原 Engage Digital。我方不维护 RingCX 平台本身，仅基于其 API 接入。

### Tickets
1. [RingCX] Digital + Handoff 跑通 & 问题识别 — Jimmie / Fairy
2. [RingCX] Inbound Voice + Handoff 跑通 & 问题识别 — Jimmie / Fairy
3. [RingCX] Outbound Voice + Handoff 调研 & 跑通 — Jimmie / Fairy
4. [RingCX] 电话号码体系 & Billing 调研 — Jimmie / Fairy
5. [RingCX] Account Autodiscovery 概念澄清 — TBD
`;

function child(
  ref: string,
  title: string,
  description: string,
  owner: string | null,
  owners: string[],
  quote: string,
): DraftPlanV1['parents'][number]['children'][number] {
  return {
    ref,
    title,
    description,
    owner,
    ownerCandidates: owners,
    schedule: { start: null, end: null, basis: 'missing' },
    dependsOnRefs: [],
    evidence: quote ? [{ sourceId: 'paste', quote }] : [],
  };
}

export const E12_PLAN: DraftPlanV1 = {
  schemaVersion: '1',
  documentTitle: 'AI Service — Nova Agent 接入 Contact Center Epics',
  globalContext: {
    background:
      'Steve 打算让团队 E2E 地对整个功能负责（Nova 侧），IVR / Telco 仍由 Troy 团队负责。新做的功能需要考虑如何和 Air 2.0 串联。Week 1 目标：先基于现有后端跑起来，识别问题。当前无 PM 支持。',
    constraints: ['IVR / Telco 仍由 Troy 团队负责', '当前无 PM 支持'],
    milestones: [
      { label: 'Week 1', date: '2026-09-15', approximate: false },
      { label: 'RingCX', date: '2026-10-16', approximate: true },
      { label: 'RCCC', date: '2026-10-30', approximate: true },
      { label: '总截止', date: '2026-11-30', approximate: true },
    ],
    risks: ['PM 聚焦 10.22 的 2.0 版本'],
  },
  parents: [
    {
      ref: 'p-inbound',
      action: 'create',
      existingItemKey: null,
      title: 'AIR as virtual assistant in RCCC - Inbound Voice',
      description:
        '将 Nova Agent 接入 RCCC Inbound Voice。外部来电 → IVR 路由 → RCCC 转接 Nova Agent → 多轮对话 → 无法解决时 handoff。',
      schedule: { start: null, end: null, basis: 'missing' },
      evidence: [{ sourceId: 'paste', quote: '将 Nova Agent 接入 RCCC Inbound Voice' }],
      children: [
        child(
          'c-in-1',
          '[RCCC Inbound] Voice + Handoff 接入',
          '依赖环境 ready：Tail 组件部署到 Nova 环境。参考 https://wiki.ringcentral.com/x/_14kQw',
          'Zack',
          ['Zack'],
          'Tail 组件部署到 Nova 环境',
        ),
        child(
          'c-in-2',
          '[RCCC Inbound] Air 与 RingEX 解耦',
          'Air 与 RingEX 解耦。',
          'Zack',
          ['Zack'],
          'Air 与 RingEX 解耦',
        ),
        child(
          'c-in-3',
          '[RCCC Inbound] 开发 & Regression 环境搭建',
          'Tail 部署到 Lab01/Lab02/INT。',
          'Barry',
          ['Barry'],
          'Tail 部署到 Lab01/Lab02/INT',
        ),
        child(
          'c-in-4',
          '[RCCC] AuditLog 审计日志对接',
          'Account 级别审计日志，约 1 人天。',
          'Bernard',
          ['Bernard'],
          '约 1 人天',
        ),
      ],
    },
    {
      ref: 'p-outbound',
      action: 'create',
      existingItemKey: null,
      title: 'AIR as virtual assistant in RCCC - Outbound Voice',
      description:
        '主动外呼：NOCC → NOA 编排 → Telco/Tail 拨出 → 接通后 Inbound 回流。Kasni 已有 design。RCCC 已有 demo（除 handoff 外已跑通）。关键待确认项：Outbound 拨出走 RCCC 平台能力还是我方 Telco 直拨。',
      schedule: { start: null, end: null, basis: 'missing' },
      evidence: [{ sourceId: 'paste', quote: '拨出走 RCCC 平台能力还是我方 Telco 直拨' }],
      children: [
        child(
          'c-out-1',
          '[RCCC Outbound] Voice + Handoff 接入',
          'Outbound Voice + Handoff。RCCC 已有 demo（除 handoff 外已跑通）。',
          'Dylan',
          ['Dylan'],
          '除 handoff 外已跑通',
        ),
        child(
          'c-out-2',
          '[RCCC Outbound] 需求确认：拨出走 RCCC 还是 Telco',
          'Outbound 拨出走 RCCC 平台能力还是我方 Telco 直拨。',
          'Dylan',
          ['Dylan'],
          '拨出走 RCCC 还是 Telco',
        ),
        child(
          'c-out-3',
          '[RCCC Outbound] 现有 Demo 验证 & Gap 识别',
          '验证现有 Demo 并识别 Gap。',
          'Dylan',
          ['Dylan'],
          '现有 Demo 验证',
        ),
      ],
    },
    {
      ref: 'p-ringcx',
      action: 'create',
      existingItemKey: null,
      title: 'AIR as virtual assistant in RingCX',
      description: '接入原 Engage Digital。我方不维护 RingCX 平台本身，仅基于其 API 接入。',
      schedule: { start: null, end: null, basis: 'missing' },
      evidence: [{ sourceId: 'paste', quote: '不维护 RingCX 平台本身' }],
      children: [
        child(
          'c-cx-1',
          '[RingCX] Digital + Handoff 跑通 & 问题识别',
          'Digital + Handoff 跑通并识别问题。',
          null,
          ['Jimmie', 'Fairy'],
          'Jimmie / Fairy',
        ),
        child(
          'c-cx-2',
          '[RingCX] Inbound Voice + Handoff 跑通 & 问题识别',
          'Inbound Voice + Handoff。',
          null,
          ['Jimmie', 'Fairy'],
          'Jimmie / Fairy',
        ),
        child(
          'c-cx-3',
          '[RingCX] Outbound Voice + Handoff 调研 & 跑通',
          'Outbound Voice + Handoff 调研。',
          null,
          ['Jimmie', 'Fairy'],
          'Jimmie / Fairy',
        ),
        child(
          'c-cx-4',
          '[RingCX] 电话号码体系 & Billing 调研',
          '电话号码体系与 Billing 调研。',
          null,
          ['Jimmie', 'Fairy'],
          'Jimmie / Fairy',
        ),
        child(
          'c-cx-5',
          '[RingCX] Account Autodiscovery 概念澄清',
          'Account Autodiscovery 概念澄清。',
          null,
          ['TBD'],
          'Account Autodiscovery 概念澄清 — TBD',
        ),
      ],
    },
  ],
  assumptions: [
    { ref: 'c-in-4', field: 'schedule', reason: '约 1 人天是估算，不是甘特条宽' },
  ],
};

export function e12PlanWithKeys(keys: {
  inbound: string;
  outbound: string;
  ringcx: string;
}): DraftPlanV1 {
  const plan: DraftPlanV1 = JSON.parse(JSON.stringify(E12_PLAN));
  plan.parents[0].existingItemKey = keys.inbound;
  plan.parents[0].action = 'attach';
  plan.parents[1].existingItemKey = keys.outbound;
  plan.parents[1].action = 'attach';
  plan.parents[2].existingItemKey = keys.ringcx;
  plan.parents[2].action = 'attach';
  return plan;
}
