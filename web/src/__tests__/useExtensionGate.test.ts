import { describe, expect, it } from 'vitest';
import {
  EXTENSION_FEATURES,
  EXTENSION_PERKS,
  JIRA_WRITE_SKIPPED_ACTION,
  JIRA_WRITE_SKIPPED_TEXT,
  extensionLockTip,
} from '../composables/useExtensionGate';

describe('extension gate copy', () => {
  it('exposes a syncJira feature used after local Jira writes skip', () => {
    expect(EXTENSION_FEATURES.syncJira.label).toBe('回写 Jira');
    expect(EXTENSION_FEATURES.syncJira.why).toContain('没有同步到 Jira');
    expect(EXTENSION_PERKS.some((perk) => perk.key === 'syncJira')).toBe(true);
  });

  it('keeps the skipped-write snackbar to one line plus a text button', () => {
    expect(JIRA_WRITE_SKIPPED_TEXT).toBe(
      '这次改动只保存在 Roadmap，没有同步到 Jira。',
    );
    expect(JIRA_WRITE_SKIPPED_ACTION).toBe('安装插件开启同步');
    expect(JIRA_WRITE_SKIPPED_TEXT.includes('\n')).toBe(false);
  });

  it('builds a lock tooltip for syncJira like the other features', () => {
    const tip = extensionLockTip('syncJira');
    expect(tip).toContain('需要 Personal AI 扩展');
    expect(tip).toContain('回写 Jira');
    expect(tip).toContain('点击查看安装指引');
  });
});
