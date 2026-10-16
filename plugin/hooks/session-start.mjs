#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { status } from '../scripts/roadmap-config.mjs';

if (!process.stdin.isTTY) readFileSync(0);

const current = status();
if (!current.configured) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          'Personal Roadmap 还没绑定团队。只有用户要规划、列出、删除或退回 Backlog 时，才先走 Roadmap Setup（$roadmap-setup），不要调用 roadmap_*，也不要编造 token。与 Roadmap 无关的请求不要提这件事。',
      },
    }),
  );
}
