import { clamp, initials } from './useGeometry';
import type { TeamMember } from '../types';
import { dispName, type AssigneeMap } from './useAssigneeMap';

const PERSON_SVG =
  '<svg width="11" height="11" viewBox="0 0 14 14"><circle cx="7" cy="4.6" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.4 12.2c.7-2.4 2.5-3.6 4.6-3.6s3.9 1.2 4.6 3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

export function personSvgHtml(): string {
  return PERSON_SVG;
}

export function memberChipHtml(member: TeamMember | null | undefined): string {
  if (!member) return PERSON_SVG;
  return `<span class="own-av" style="background:${member.avatarColor}">${escapeHtml(initials(member.name))}</span>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fixed-position member picker: search/add on top, scrollable list,
 * keyboard nav, flips upward when near the viewport bottom.
 */
export function openOwnerFloat(
  anchor: HTMLElement,
  members: TeamMember[],
  currentName: string | null | undefined,
  onPick: (member: TeamMember | null) => void,
  opts: { allowClear?: boolean; assigneeMap?: AssigneeMap } = {},
): void {
  document.querySelectorAll('.owner-float').forEach((el) => el.remove());
  const pop = document.createElement('div');
  pop.className = 'owner-pop show owner-float';
  pop.innerHTML = `
    <div class="owner-search"><input placeholder="搜索成员，或输入新名字 Enter 添加…"></div>
    <div class="owner-list"></div>`;
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.left = `${clamp(r.left, 8, window.innerWidth - 230)}px`;

  const inp = pop.querySelector('input') as HTMLInputElement;
  const listEl = pop.querySelector('.owner-list') as HTMLElement;
  let q = '';
  let idx = 0;
  let list: TeamMember[] = [];

  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const onOutside = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node) && e.target !== anchor) close();
  };
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true));
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());

  const place = () => {
    const h = pop.offsetHeight;
    const below = r.bottom + 6;
    pop.style.top =
      below + h > window.innerHeight - 8
        ? `${Math.max(8, r.top - 6 - h)}px`
        : `${below}px`;
  };

  const renderList = () => {
    const ql = q.toLowerCase();
    list = members.filter((m) => {
      if (!ql) return true;
      return (
        m.name.toLowerCase().includes(ql) ||
        dispName(opts.assigneeMap, m.name).toLowerCase().includes(ql)
      );
    });
    idx = clamp(idx, 0, Math.max(0, list.length - 1));
    const clearRow =
      opts.allowClear && currentName && !q
        ? `<div class="owner-item" data-clear><span class="own-av" style="background:#C6CDD4">–</span>移除 Owner</div>`
        : '';
    listEl.innerHTML =
      clearRow +
      (list.length
        ? list
            .map(
              (m, i) =>
                `<div class="owner-item ${i === idx ? 'act' : ''}" data-i="${i}">
        <span class="own-av" style="background:${m.avatarColor}">${escapeHtml(initials(m.name))}</span>${escapeHtml(dispName(opts.assigneeMap, m.name))}${currentName && m.name === currentName ? ' ✓' : ''}</div>`,
            )
            .join('')
        : `<div class="owner-none">无匹配成员 —— Enter 将「${escapeHtml(inp.value.trim())}」加入团队</div>`);

    listEl.querySelectorAll('.owner-item').forEach((el) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if ((el as HTMLElement).hasAttribute('data-clear')) onPick(null);
        else {
          const i = Number((el as HTMLElement).dataset.i);
          onPick(list[i] || null);
        }
        close();
      });
    });
    const act = listEl.querySelector('.act') as HTMLElement | null;
    act?.scrollIntoView({ block: 'nearest' });
    place();
  };

  inp.oninput = () => {
    q = inp.value.trim();
    idx = 0;
    renderList();
  };
  inp.onkeydown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.length) {
        idx = (idx + 1) % list.length;
        renderList();
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.length) {
        idx = (idx - 1 + list.length) % list.length;
        renderList();
      }
      return;
    }
    if (e.key === 'Enter') {
      if (list.length) {
        onPick(list[idx]);
        close();
      } else if (inp.value.trim()) {
        const name = inp.value.trim();
        const existing = members.find(
          (m) => m.name.toLowerCase() === name.toLowerCase(),
        );
        onPick(
          existing || {
            id: '',
            name,
            avatarColor: '#8895A5',
          },
        );
        close();
      }
      return;
    }
    if (e.key === 'Escape') close();
  };

  renderList();
  setTimeout(() => inp.focus(), 30);
}
