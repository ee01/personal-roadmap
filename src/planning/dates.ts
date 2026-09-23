import { addDaysIso, diffDaysIso } from '../core/assigneeMap.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !ISO.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
  );
}

export function inclusiveDays(start: string, end: string): number {
  return Math.max(1, diffDaysIso(start, end) + 1);
}

export function endFromStart(start: string, days: number): string {
  return addDaysIso(start, Math.max(1, days) - 1);
}

export function compareIso(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export function minIso(a: string, b: string): string {
  return compareIso(a, b) <= 0 ? a : b;
}

export function maxIso(a: string, b: string): string {
  return compareIso(a, b) >= 0 ? a : b;
}

export function parseQuarter(quarter: string | null | undefined): {
  year: number;
  q: number;
  start: string;
  end: string;
} | null {
  const match = String(quarter || '').trim().match(/^(\d{4})-Q([1-4])$/i);
  if (!match) return null;
  const year = Number(match[1]);
  const q = Number(match[2]);
  const startMonth = (q - 1) * 3 + 1;
  const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const endMonth = startMonth + 2;
  const endDay = new Date(year, endMonth, 0).getDate();
  const end = `${year}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
  return { year, q, start, end };
}

export function todayInTimeZone(
  nowMs: number,
  timeZone: string,
): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(nowMs));
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    /* invalid tz */
  }
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function defaultPlanningStart(input: {
  quarter: string | null;
  referenceDate: string;
}): string {
  const q = parseQuarter(input.quarter);
  if (!q) return input.referenceDate;
  if (input.referenceDate >= q.start && input.referenceDate <= q.end) {
    return input.referenceDate;
  }
  return q.start;
}

export { addDaysIso, diffDaysIso };
