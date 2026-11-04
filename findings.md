# Findings

Accepted source: docs/demo/dependency-view-plan.md and roadmap-demo.html. Latest comment authorizes production implementation and adds dependency-specific top-right copy. Existing branch main, ahead 6; AGENTS.md modified and unrelated untracked files pre-exist.

Implementation keeps marker.date as confirmed ETA for compatibility; adds nullable need, etaAt, jiraTargetStart via migration 022. Existing bulk Jira bridge already returns Target Start, so production can reuse it without editing/reloading the extension. Shared DependencyTrack prevents ETA mutation on drag. First full test found only migration ledger expectations needing the new entry (3 failures); fixed expectations and adding coverage.

Demo audit: keyboard moves normalize only exact equality; drag snaps within ±1 day. Implemented separate paths and serialized repeated keyboard intents after browser testing caught a rapid-key version conflict. All QA uses an isolated temporary SQLite database. Production smoke probe uses its own temp database and checks route auth/OCC and new-field roundtrip without mutating production data.

2026-10-22: Screenshot confirms expectation input lacked the ETA class/style after the subsequent dependency-view rewrite. Production editor now has shared date styles in global tokens.css, Jira key save/Enter support, and viewport-constrained popover. Rebinding clears old mirrors; Jira-derived old ETA is not assigned to a new ticket. Effective expectation is retained. Unlink keeps known date as manual. Existing Design data remains compatible while the preset is removed.

Accepted navigation: 7ed6a0e demo + navigation section in dependency-view-plan.md. Keep viewMatch pure: adding the temporary pin globally would pollute Backlog and clipboard scope, so only GanttRow overrides hide/dim for the active target. Locate sessions/URL are viewer-local. Resource selection is hoisted into viewer state so the locate icon does not select/clear tasks during source remount. Current q URL parameter is quarter, not search; focus remains independent.
