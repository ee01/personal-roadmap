import { describe, expect, it } from 'vitest';
import { ganttAliasEditDirty } from '../composables/ganttAliasEdit';

const draft = {
  editingTitle: true,
  value: '登录改造',
  baselineValue: '登录改造',
  description: '原描述',
  baselineDescription: '原描述',
};

const jira = {
  editingTitle: false,
  value: '登录',
  baselineValue: '登录',
  description: '',
  baselineDescription: '',
};

describe('ganttAliasEditDirty', () => {
  it('stays clean for an untouched draft or jira epic', () => {
    expect(ganttAliasEditDirty(draft)).toBe(false);
    expect(ganttAliasEditDirty(jira)).toBe(false);
  });

  it('treats a changed draft title or description as dirty', () => {
    expect(ganttAliasEditDirty({ ...draft, value: '登录改造 v2' })).toBe(true);
    expect(ganttAliasEditDirty({ ...draft, description: '新描述' })).toBe(true);
  });

  it('treats a changed jira alias as dirty and ignores description', () => {
    expect(ganttAliasEditDirty({ ...jira, value: '登录页' })).toBe(true);
    expect(ganttAliasEditDirty({ ...jira, description: '不会编辑' })).toBe(false);
  });

  it('ignores whitespace that trims back to the original text', () => {
    expect(ganttAliasEditDirty({ ...draft, value: '  登录改造  ' })).toBe(false);
    expect(ganttAliasEditDirty({ ...jira, value: '登录 ' })).toBe(false);
  });
});
