# Progress

2026-10-21: Read issue, all thread summaries and triggering thread; changed issue from in_review to in_progress. Read accepted rules and mapped initial files.

Server compiles. Dependency view, focused popover and Gantt shared track implemented. Dependency copy collection/rendering added with per-view options. Regression coverage and browser validation now in progress.

Final verification: 40 files / 299 tests passed; npm run build passed; vue-tsc passed; built-route smoke passed. Browser validated ETA-preserving drag, undo, exact-day keyboard moves/merge, rapid key serialization, Shift 7-day moves, missing-ETA default, automatic ticket ETA read, silent-vs-explicit refresh, focused Gantt-to-dependency navigation, read-only inputs/no writes, filtered rich clipboard and TSV, and independent per-view format memory. Jira bridge was simulated (no live Jira writes). Fixed pre-existing Vue type casts in adjacent clipboard/resource/planning code so full type check passes. Deployment pending.

Committed bf4b5ab on main. npm run deploy completed successfully. Both local-on-host and public /health returned ok:true. Production migration ledger contains 022_dependency_expectation and all three new columns. Production frontend serves index-epcL-799.js. Container route smoke passed against its own temporary database (production data untouched). Closed QA browser and stopped the exact local QA node PID 92796 (daemon PID was 1518). Issue moved to in_review.

2026-10-22: Read server-provided comment delta. Other agent already delivered chat-copy format and demo-aligned dependency layout (63d7281/be9f1d0); preserve them. Latest request: remove Design preset, allow existing-dependency Jira editing, style expectation date to match ETA. Starting from main ahead 9; only pre-existing AGENTS.md modification and untracked scratch/runtime files.

Follow-up implementation and checks complete: 303 tests passed; build and full Vue type check passed; API smoke now covers rebind/unlink. Browser checked preset list, no-extension bind/rebind/unlink, invalid key handling, manual ETA change, mocked extension Target Start/End read, readonly inputs, and matching 32px date fields. Cropped editor screenshot visually inspected. Commit/deploy next; no schema migration added.

Final follow-up checks: 304 tests passed after adding case-insensitive ticket identity regression. Commit bd90413 on main; deploy exited 0. Server and public health returned ok:true, production serves index-C7Pq6dA0.js, latest migration remains 022 (none added). Deployed container API smoke passed ticket rebind/unlink against isolated temporary DB. QA browser closed and exact QA PID 94510 stopped (daemon PID 82214). Issue moved to in_review.

Independent focus parsing/resolution/timeline helper, local navigation session and URL restore implemented. Source buttons, Gantt scrolling/paired-node highlight, temporary pin, return restoration and Escape/manual cancel wired. Dependency chat now uses hyphen plaintext and semantic ul/li HTML. Unit/type and browser checks next.

Navigation verification complete: 307 tests / 41 files passed, full Vue type check/build/API smoke passed. Browser verified exact Epic/dependency/subtask navigation, paired highlight, source scroll 1094px restored exactly, preserved search/risk filter/resource selection, manual switch/Escape/close cancellation, readonly focus links/reload, hidden target pin and unaffected zero copy count, invalid target feedback, and 0 POST intents during navigation. Clipboard HTML contains 14 ul>li items (not paragraphs); plaintext uses hyphens. Production commit/deployment pending.

Navigation committed on main as 72298c8 and deployed successfully. Server/public health returned ok:true; production asset index-DYKhfFCy.js contains locate code. Deployed API smoke passed against isolated temporary database. No new migration (latest remains 022) or server endpoint. QA browser closed and exact PID 5421 stopped after checking daemon PID 82214. Issue moved to in_review.
