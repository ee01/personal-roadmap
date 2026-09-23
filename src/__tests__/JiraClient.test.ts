import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    jira: {
      baseUrl: 'https://jira.example.com',
      pat: 'test-pat',
      fieldTargetStart: 'customfield_18350',
      fieldTargetEnd: 'customfield_18351',
      enabled: true,
    },
  },
}));

const { addIsoDays, jiraUpdateTargetDates, jiraSearchChildTasks, JiraHttpError } =
  await import('../core/JiraClient.js');

describe('JiraClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('addIsoDays stays on calendar dates', () => {
    expect(addIsoDays('2026-08-01', 0)).toBe('2026-08-01');
    expect(addIsoDays('2026-08-01', 13)).toBe('2026-08-14');
    expect(addIsoDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('jiraUpdateTargetDates PUTs Target Start/End fields', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => '',
    });
    await jiraUpdateTargetDates('NOVA-1', '2026-08-01', '2026-08-14');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe('https://jira.example.com/rest/api/2/issue/NOVA-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      fields: {
        customfield_18350: '2026-08-01',
        customfield_18351: '2026-08-14',
      },
    });
  });

  it('jiraSearchChildTasks paginates and maps assignee', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [
            {
              key: 'NOVA-9',
              fields: {
                summary: 'Child task',
                assignee: { displayName: 'Vivi' },
                customfield_18350: '2026-08-03',
                customfield_18351: '2026-08-10',
                customfield_11450: 'NOVA-1',
              },
            },
          ],
        }),
      });

    const rows = await jiraSearchChildTasks(['NOVA-1'], {
      projectKey: 'NOVA',
      itemType: 'Epic',
      subType: 'Task',
      linkField: 'customfield_11450',
      confident: true,
    });
    expect(rows).toEqual([
      {
        key: 'NOVA-9',
        summary: 'Child task',
        epicKey: 'NOVA-1',
        targetStart: '2026-08-03',
        targetEnd: '2026-08-10',
        assignee: 'Vivi',
        originalEstimateDays: null,
      },
    ]);
  });

  it('throws JiraHttpError on non-2xx', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad fields',
    });
    await expect(
      jiraUpdateTargetDates('NOVA-1', '2026-08-01', '2026-08-02'),
    ).rejects.toBeInstanceOf(JiraHttpError);
  });
});
