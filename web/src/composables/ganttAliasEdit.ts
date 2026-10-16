/**
 * Double-click edit on a gantt bar (draft title/description, or Jira alias).
 * Once the text differs from what was opened, an outside click must not dismiss
 * the editor — only Enter saves and Escape cancels.
 */
export interface GanttAliasEditFields {
  editingTitle: boolean;
  value: string;
  baselineValue: string;
  description: string;
  baselineDescription: string;
}

export function ganttAliasEditDirty(fields: GanttAliasEditFields): boolean {
  if (fields.value.trim() !== fields.baselineValue.trim()) return true;
  if (!fields.editingTitle) return false;
  return fields.description.trim() !== fields.baselineDescription.trim();
}
