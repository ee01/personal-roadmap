# DraftPlanV1

`schemaVersion` 必须是 `"1"`。禁止 `teamId`、`jiraKey`、`source`、`sql`、`intent`、`shareToken`、`token`、`apiKey`。

```json
{
  "schemaVersion": "1",
  "documentTitle": "string",
  "globalContext": {
    "background": "string",
    "constraints": ["string"],
    "milestones": [{ "label": "string", "date": "YYYY-MM-DD|null", "approximate": false }],
    "risks": ["string"]
  },
  "parents": [
    {
      "ref": "p1",
      "action": "create|attach",
      "existingItemKey": "LOCAL-xxx or null",
      "title": "string <= 200",
      "description": "string <= 2000",
      "schedule": { "start": "YYYY-MM-DD|null", "end": "YYYY-MM-DD|null", "basis": "explicit|inferred|missing" },
      "evidence": [{ "sourceId": "paste", "quote": "verbatim substring" }],
      "children": [
        {
          "ref": "c1",
          "title": "string",
          "description": "string",
          "ownerCandidates": ["string"],
          "owner": "string|null",
          "schedule": { "start": null, "end": null, "basis": "missing" },
          "dependsOnRefs": [],
          "evidence": []
        }
      ]
    }
  ],
  "assumptions": [{ "ref": "c1", "field": "schedule", "reason": "string" }]
}
```

- `attach` 的 `existingItemKey` 必须来自本次 context，不能发明。
- quote 必须能在对应 `sourceId` 原文中找到。
- 日期为 `YYYY-MM-DD`；duration 是含首尾自然日。
- 参考日期与规划起点分开：`referenceDate` 解释「下周」，`planningStart` 是初排锚点。E-12 固定 `referenceDate=2026-09-16`。
