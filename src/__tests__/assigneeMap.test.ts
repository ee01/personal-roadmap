import { describe, expect, it } from 'vitest';
import {
  importedTaskSpan,
  mergeAssigneeMapIdentities,
  migrateAssigneeMapKey,
  normalizeAssigneeMap,
  ownerMatchesAssignee,
  parseAssigneeMap,
} from '../core/assigneeMap.js';

describe('importedTaskSpan', () => {
  const epic = { start: '2026-08-01', days: 30 };

  it('uses both Target dates when present', () => {
    expect(importedTaskSpan(epic, '2026-08-03', '2026-08-10')).toEqual({
      start: '2026-08-03',
      days: 8,
    });
  });

  it('mirrors parent when both Targets missing', () => {
    expect(importedTaskSpan(epic, null, null)).toEqual({
      start: '2026-08-01',
      days: 30,
    });
  });

  it('starts at Target Start for two weeks, clamped to parent end', () => {
    expect(importedTaskSpan(epic, '2026-08-25', null)).toEqual({
      start: '2026-08-25',
      days: 6,
    });
  });

  it('ends at Target End looking back two weeks, clamped to parent start', () => {
    expect(importedTaskSpan(epic, null, '2026-08-05')).toEqual({
      start: '2026-08-01',
      days: 5,
    });
  });
});

describe('assignee map helpers', () => {
  it('parses and normalizes keys to lowercase', () => {
    expect(parseAssigneeMap('{"Ray":"Ray Zhang"}')).toEqual({
      ray: 'Ray Zhang',
    });
    expect(normalizeAssigneeMap({ Vivi: 'Vivi Wang', '': 'x' })).toEqual({
      vivi: 'Vivi Wang',
    });
  });

  it('migrates map key on member rename', () => {
    expect(
      migrateAssigneeMapKey({ ray: 'Ray Zhang' }, 'ray', 'Ray Zhang'),
    ).toEqual({ 'ray zhang': 'Ray Zhang' });
  });

  it('merges identities while keeping the short-name alias', () => {
    expect(
      mergeAssigneeMapIdentities({ ray: 'Something Else' }, 'ray', 'Ray Zhang'),
    ).toEqual({
      ray: 'Ray Zhang',
      'ray zhang': 'Ray Zhang',
    });
  });
});

describe('ownerMatchesAssignee', () => {
  const map = { esone: 'Esone Qiu', ada: 'Ada Lovelace' };

  it('treats mapped full name as the same person', () => {
    expect(ownerMatchesAssignee(map, 'esone', 'Esone Qiu')).toBe(true);
    expect(ownerMatchesAssignee(map, 'Esone Qiu', 'Esone Qiu')).toBe(true);
    expect(ownerMatchesAssignee(map, 'esone', 'Kevin Liu')).toBe(false);
  });
});
