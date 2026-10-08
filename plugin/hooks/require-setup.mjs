#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { SETUP_HINT, status } from '../scripts/roadmap-config.mjs';

if (!process.stdin.isTTY) readFileSync(0);

const current = status();
if (!current.configured) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: SETUP_HINT,
      },
    }),
  );
}
