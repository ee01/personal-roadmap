import { describe, expect, it } from 'vitest';
import {
  EPIC_LINK_FIELD,
  PARENT_FIELD,
  PARENT_LINK_FIELD,
  buildJqlHints,
  parseIssueType,
  parseProjectKey,
  parseTeamValues,
  resolveSubType,
  stripQuotedSegments,
} from '../core/JqlIntrospect.js';

const REAL_WORLD_JQL =
  `issueFunction in portfolioChildrenOf('project = INIT AND Team in ("Nova CA - Brandy") ` +
  `AND "Target Delivery Quarter" in (2026-Q3) AND status not in (Cancelled)') ` +
  `and issuetype = Epic and status not in (Cancelled, Closed) ` +
  `and project=NOVA and Team in ("Nova CA - Brandy")`;

describe('stripQuotedSegments', () => {
  it('removes the nested JQL carried inside single quotes', () => {
    const stripped = stripQuotedSegments(REAL_WORLD_JQL);
    expect(stripped).not.toContain('INIT');
    expect(stripped).toContain('project=NOVA');
  });
});

describe('parseProjectKey', () => {
  it('ignores the inner project and takes the outer one', () => {
    expect(parseProjectKey(REAL_WORLD_JQL)).toBe('NOVA');
  });

  it('supports quoted and list forms', () => {
    expect(parseProjectKey('project = "NOVA" AND status = Open')).toBe('NOVA');
    expect(parseProjectKey('project in (NOVA, INIT)')).toBe('NOVA');
  });

  it('returns null when there is no project clause', () => {
    expect(parseProjectKey('assignee = currentUser()')).toBeNull();
    expect(parseProjectKey('')).toBeNull();
  });
});

describe('parseIssueType', () => {
  it('reads the outer issuetype equality clause', () => {
    expect(parseIssueType(REAL_WORLD_JQL)).toBe('Epic');
  });

  it('reads the first value of an in-list', () => {
    expect(parseIssueType('issuetype in (Epic, Story) and project = NOVA')).toBe(
      'Epic',
    );
    expect(parseIssueType('issuetype in ("User Story", Bug)')).toBe(
      'User Story',
    );
  });

  it('canonicalises casing so the value can be posted back to Jira', () => {
    expect(parseIssueType('issueType = epic')).toBe('Epic');
    expect(parseIssueType('issuetype = INITIATIVE')).toBe('Initiative');
  });

  it('ignores negated clauses', () => {
    expect(parseIssueType('issuetype not in (Epic) and project = NOVA')).toBeNull();
  });
});

describe('parseTeamValues', () => {
  it('reads every value of an outer Team in-list, keeping order', () => {
    expect(
      parseTeamValues(
        'project=NOVA and Team in ("Nova CA - Brandy", "Nova CA - Tony")',
      ),
    ).toEqual(['Nova CA - Brandy', 'Nova CA - Tony']);
  });

  it('supports the custom-field spelling and equality form', () => {
    expect(parseTeamValues('"Team[Team]" = "Nova CA - Brandy"')).toEqual([
      'Nova CA - Brandy',
    ]);
    expect(parseTeamValues('Team = Nova-CA')).toEqual(['Nova-CA']);
  });

  it('de-duplicates and ignores negated clauses and functions', () => {
    expect(
      parseTeamValues(
        'Team in ("A Team", "a team") and Team not in ("B Team")',
      ),
    ).toEqual(['A Team']);
    expect(parseTeamValues('Team = currentUser()')).toEqual([]);
    expect(parseTeamValues('')).toEqual([]);
  });
});

describe('resolveSubType', () => {
  it('maps Initiative to Epic children via Parent Link', () => {
    expect(resolveSubType('Initiative')).toEqual({
      subType: 'Epic',
      linkField: PARENT_LINK_FIELD,
    });
    expect(resolveSubType('INIT').linkField).toBe(PARENT_LINK_FIELD);
  });

  it('maps Epic to Task children via Epic Link', () => {
    expect(resolveSubType('Epic')).toEqual({
      subType: 'Task',
      linkField: EPIC_LINK_FIELD,
    });
  });

  it('treats task-level and unknown types as native sub-tasks', () => {
    for (const type of ['Task', 'Story', 'User Story', 'Bug', 'Improvement']) {
      expect(resolveSubType(type)).toEqual({
        subType: null,
        linkField: PARENT_FIELD,
      });
    }
  });
});

describe('buildJqlHints', () => {
  it('is confident when the JQL names the issue type', () => {
    expect(buildJqlHints({ jql: REAL_WORLD_JQL })).toEqual({
      projectKey: 'NOVA',
      itemType: 'Epic',
      subType: 'Task',
      linkField: EPIC_LINK_FIELD,
      confident: true,
      teams: ['Nova CA - Brandy'],
    });
  });

  it('falls back to the nested portfolioChildrenOf Team clause', () => {
    expect(
      buildJqlHints({
        jql: `issueFunction in portfolioChildrenOf('project = INIT AND Team in ("Nova CA - Brandy")') and project=NOVA`,
      }).teams,
    ).toEqual(['Nova CA - Brandy']);
  });

  it('falls back to the mode of already imported item types', () => {
    const hints = buildJqlHints({
      jql: 'project = NOVA and status not in (Closed)',
      modeItemType: 'Initiative',
    });
    expect(hints.itemType).toBe('Initiative');
    expect(hints.subType).toBe('Epic');
    expect(hints.linkField).toBe(PARENT_LINK_FIELD);
    expect(hints.confident).toBe(true);
  });

  it('guesses Epic but reports low confidence when nothing resolved', () => {
    const hints = buildJqlHints({ jql: 'assignee = currentUser()' });
    expect(hints).toEqual({
      projectKey: null,
      itemType: 'Epic',
      subType: 'Task',
      linkField: EPIC_LINK_FIELD,
      confident: false,
      teams: [],
    });
  });
});
