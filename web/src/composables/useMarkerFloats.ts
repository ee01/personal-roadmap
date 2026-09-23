import {
  addD,
  clamp,
  DAY_W,
  diffD,
  fmtISO,
  fmtMD,
  parseDate,
  today,
  X,
  type Timeline,
} from './useGeometry';
import {
  PHASE_DEFS,
  canAdoptJiraTargetEnd,
  defaultPhaseDate,
  depAdoptLabel,
  depEtaMismatchesJira,
  depStatusChipLabel,
  depStatusIsStale,
  jiraBrowseUrl,
} from './useRoadmapContract';
import { extensionLockTip, useExtensionGate } from './useExtensionGate';
import type { PhaseKind, RoadmapItem, RoadmapMarker } from '../types';

const { openGate } = useExtensionGate();

const LINK_SVG =
  '<svg width="9" height="9" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 8.2l2.2-2.2a2.2 2.2 0 013.1 3.1L9.1 11.3a2.2 2.2 0 01-3.1 0"/><path d="M8 5.8L5.8 8a2.2 2.2 0 01-3.1-3.1L5 2.7a2.2 2.2 0 013.1 0"/></svg>';

const EXT_SVG =
  '<svg width="8" height="8" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H3.5A1.5 1.5 0 002 4.5v6A1.5 1.5 0 003.5 12h6A1.5 1.5 0 0011 10.5V8M8.5 2H12v3.5M12 2L6.8 7.2"/></svg>';

const REFRESH_SVG =
  '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7A5 5 0 1 1 10.6 3.6"/><path d="M12 2.2V5H9.2"/></svg>';

export function linkIconHtml(size = 9): string {
  return LINK_SVG.replace('width="9" height="9"', `width="${size}" height="${size}"`);
}

export function closeMarkerFloats() {
  document
    .querySelectorAll('.marker-menu,.marker-editor,.dep-form,.dep-popover')
    .forEach((el) => el.remove());
}

function floatAt(anchor: HTMLElement, cls: string, width?: number) {
  closeMarkerFloats();
  const p = document.createElement('div');
  p.className = `owner-pop show ${cls}`;
  if (width) p.style.width = `${width}px`;
  const r = anchor.getBoundingClientRect();
  p.style.position = 'fixed';
  p.style.left = `${clamp(r.left - (width ? width * 0.4 : 0), 8, window.innerWidth - (width || 230) - 8)}px`;
  p.style.top = `${r.bottom + 6}px`;
  document.body.appendChild(p);
  const close = () => {
    p.remove();
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const onOutside = (e: PointerEvent) => {
    if (!p.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) {
      close();
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true));
  p.addEventListener('pointerdown', (e) => e.stopPropagation());
  return { p, close };
}

export type MarkerHandlers = {
  addMarker: (intent: Record<string, unknown>) => Promise<void>;
  updateMarker: (intent: Record<string, unknown>) => Promise<void>;
  deleteMarker: (intent: Record<string, unknown>) => Promise<void>;
  toast: (html: string) => void;
  fetchIssueDates?: (jiraKey: string) => Promise<{
    targetEnd: string | null;
    status: string | null;
  }>;
  hasExtension: boolean;
  editable: boolean;
  jiraBaseUrl?: string;
};

export function openMarkerMenu(
  anchor: HTMLElement,
  item: RoadmapItem,
  handlers: MarkerHandlers,
) {
  if (!handlers.editable) return;
  const { p, close } = floatAt(anchor, 'marker-menu', 220);
  p.innerHTML = `
    <div class="mm-sec-label">阶段节点</div>
    <div class="owner-item" data-phase="design"><span class="mm-dot" style="background:${PHASE_DEFS.design.color}"></span>Design</div>
    <div class="owner-item" data-phase="stage"><span class="mm-dot" style="background:${PHASE_DEFS.stage.color}"></span>Stage</div>
    <div class="owner-item" data-phase="production"><span class="mm-dot" style="background:${PHASE_DEFS.production.color}"></span>Production</div>
    <div class="owner-item" data-phase="custom"><span class="mm-dot" style="background:${PHASE_DEFS.custom.color}"></span>自定义节点…</div>
    <div class="divider"></div>
    <div class="mm-sec-label">外部依赖</div>
    <div class="owner-item" data-dep>${linkIconHtml(10)}<span style="margin-left:7px">添加外部依赖…</span></div>`;
  p.querySelectorAll('[data-phase]').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const kind = (el as HTMLElement).dataset.phase as PhaseKind;
      close();
      if (kind === 'custom') openCustomPhaseForm(anchor, item, handlers);
      else void addPhase(item, kind, handlers);
    });
  });
  p.querySelector('[data-dep]')?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
    openDepForm(anchor, item, handlers);
  });
}

async function addPhase(
  item: RoadmapItem,
  kind: PhaseKind,
  handlers: MarkerHandlers,
  customLabel?: string,
) {
  const label =
    kind === 'custom'
      ? customLabel || 'Custom'
      : PHASE_DEFS[kind].label || kind;
  const date = defaultPhaseDate(item);
  await handlers.addMarker({
    op: 'add_marker',
    itemKey: item.key,
    kind: 'phase',
    phaseKind: kind,
    label,
    date,
  });
  handlers.toast(
    `已添加节点「${label}」· ${fmtMD(date)}，可点击标记调整日期`,
  );
}

function openCustomPhaseForm(
  anchor: HTMLElement,
  item: RoadmapItem,
  handlers: MarkerHandlers,
) {
  const { p, close } = floatAt(anchor, 'marker-menu', 240);
  p.innerHTML = `<div style="padding:8px">
    <input class="me-field" placeholder="自定义节点名称，Enter 添加…">
  </div>`;
  const inp = p.querySelector('input') as HTMLInputElement;
  inp.focus();
  inp.onkeydown = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && inp.value.trim()) {
      close();
      void addPhase(item, 'custom', handlers, inp.value.trim());
    }
  };
}

export function openPhaseEditor(
  anchor: HTMLElement,
  item: RoadmapItem,
  marker: RoadmapMarker,
  handlers: MarkerHandlers,
) {
  if (!handlers.editable) return;
  const isCustom = marker.phaseKind === 'custom';
  const { p, close } = floatAt(anchor, 'marker-editor', 230);
  p.innerHTML = `
    <div style="padding:8px 9px 4px">
      ${
        isCustom
          ? `<input class="me-field me-label" style="margin-bottom:7px" value="">`
          : `<div class="me-title" style="font-size:12.5px;font-weight:600;margin-bottom:7px"></div>`
      }
      <input type="date" class="me-field me-date" value="${marker.date || ''}">
      <div class="df-hint">也可以直接在时间轴上左右拖动该标记改期</div>
    </div>
    <div class="divider"></div>
    <div class="owner-item" data-del style="color:var(--danger)">删除该节点</div>`;
  if (isCustom) {
    (p.querySelector('.me-label') as HTMLInputElement).value = marker.label;
  } else {
    (p.querySelector('.me-title') as HTMLElement).textContent = marker.label;
  }
  const dateInp = p.querySelector('.me-date') as HTMLInputElement;
  dateInp.onchange = async () => {
    if (!dateInp.value) return;
    try {
      await handlers.updateMarker({
        op: 'update_marker',
        markerId: marker.id,
        itemKey: item.key,
        date: dateInp.value,
        baseVersion: marker.version,
      });
      close();
    } catch {
      /* toast from apply */
    }
  };
  if (isCustom) {
    const labelInp = p.querySelector('.me-label') as HTMLInputElement;
    labelInp.onchange = async () => {
      const label = labelInp.value.trim() || marker.label;
      try {
        await handlers.updateMarker({
          op: 'update_marker',
          markerId: marker.id,
          itemKey: item.key,
          label,
          baseVersion: marker.version,
        });
        close();
      } catch {
        /* toast from apply */
      }
    };
  }
  p.querySelector('[data-del]')?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
    void handlers
      .deleteMarker({
        op: 'delete_marker',
        markerId: marker.id,
        itemKey: item.key,
      })
      .then(() => handlers.toast('节点已删除'))
      .catch(() => undefined);
  });
}

/**
 * Demo-parity: drag marker left/right to change date; no movement = click
 * (open phase editor / dep popover).
 */
export function markerDragStart(
  e: PointerEvent,
  opts: {
    marker: RoadmapMarker;
    item: RoadmapItem;
    tl: Timeline;
    handlers: MarkerHandlers;
  },
) {
  if (e.button !== 0) return;
  const { marker, item, tl, handlers } = opts;
  if (!marker.date) return;
  e.preventDefault();
  e.stopPropagation();

  const el = e.currentTarget as HTMLElement;
  const origDate = parseDate(marker.date);
  const origX = e.clientX;
  const hint = document.querySelector('.drag-hint') as HTMLElement | null;
  const gsEl = el.closest('.gantt-scroll') as HTMLElement | null;
  const track = el.parentElement;
  let moved = false;
  let cur = origDate;
  let scrolled = 0;
  let guide: HTMLElement | null = null;

  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }

  const onMove = (ev: PointerEvent) => {
    const dx = ev.clientX - origX;
    if (!moved && Math.abs(dx) < 3) return;
    if (!handlers.editable) return;
    if (!moved) {
      moved = true;
      el.classList.add('dragging');
      document.body.classList.add('no-select');
      closeMarkerFloats();
      if (track) {
        guide = document.createElement('div');
        guide.className = 'marker-guide';
        track.appendChild(guide);
      }
    }
    if (gsEl) {
      const sr = gsEl.getBoundingClientRect();
      if (ev.clientX > sr.right - 50) {
        gsEl.scrollLeft += 14;
        scrolled += 14;
      } else if (ev.clientX < sr.left + 50) {
        const before = gsEl.scrollLeft;
        gsEl.scrollLeft = Math.max(0, before - 14);
        scrolled -= before - gsEl.scrollLeft;
      }
    }
    const dd = Math.round((dx + scrolled) / DAY_W.value);
    cur = addD(
      origDate,
      clamp(dd, diffD(origDate, tl.start), diffD(origDate, tl.end)),
    );
    const px = X(tl, cur) + DAY_W.value / 2;
    el.style.left = `${px}px`;
    if (guide) guide.style.left = `${px}px`;
    if (hint) {
      hint.style.display = 'block';
      hint.style.left = `${ev.clientX + 14}px`;
      hint.style.top = `${ev.clientY - 34}px`;
      hint.textContent = `${marker.kind === 'phase' ? marker.label : 'ETA'} · ${fmtMD(cur)}`;
    }
  };

  const onUp = async () => {
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    if (hint) hint.style.display = 'none';
    document.body.classList.remove('no-select');
    if (guide) guide.remove();
    el.classList.remove('dragging');

    if (!moved) {
      if (marker.kind === 'phase') openPhaseEditor(el, item, marker, handlers);
      else openDepPopover(el, item, handlers);
      return;
    }

    const next = fmtISO(cur);
    if (next === marker.date) {
      el.style.left = `${X(tl, marker.date) + DAY_W.value / 2}px`;
      return;
    }
    try {
      await handlers.updateMarker({
        op: 'update_marker',
        markerId: marker.id,
        itemKey: item.key,
        date: next,
        etaSource: marker.kind === 'dep' ? 'manual' : undefined,
        baseVersion: marker.version,
      });
      handlers.toast(
        marker.kind === 'phase'
          ? `${marker.label} 已改到 ${fmtMD(next)}`
          : `<span class="ok">✓</span> 外部依赖 ETA 已改到 ${fmtMD(next)}（手动调整）`,
      );
    } catch {
      el.style.left = `${X(tl, marker.date) + DAY_W.value / 2}px`;
    }
  };

  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

export function openDepForm(
  anchor: HTMLElement,
  item: RoadmapItem,
  handlers: MarkerHandlers,
) {
  if (!handlers.editable) return;
  const { p, close } = floatAt(anchor, 'dep-form', 280);
  p.innerHTML = `
    <div style="padding:9px 10px 6px">
      <input class="me-field df-title" placeholder="依赖描述，例如：等待平台团队接口就绪" style="margin-bottom:7px">
      <div class="df-row" style="margin-bottom:7px">
        <input class="me-field df-jira" placeholder="Jira Key（可选），如 PLAT-123" style="font-family:var(--mono)">
        <button class="df-fetch${handlers.hasExtension ? '' : ' locked'}" type="button"${
          handlers.hasExtension ? '' : ` data-tip="${extensionLockTip('fetchEta')}"`
        }>读取 ETA</button>
      </div>
      <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">交付时间 ETA（可留空）</label>
      <input type="date" class="me-field df-eta">
      <div class="df-hint">留空则在任务条角标上持续提醒需要跟进获取 ETA</div>
    </div>
    <div class="m-foot" style="padding:9px;gap:6px;border-top:1px solid var(--line2)">
      <button class="btn btn-ghost df-cancel" type="button" style="padding:5px 12px;font-size:12px">取消</button>
      <button class="btn btn-primary df-save" type="button" style="padding:5px 12px;font-size:12px">保存</button>
    </div>`;
  const jiraInp = p.querySelector('.df-jira') as HTMLInputElement;
  const etaInp = p.querySelector('.df-eta') as HTMLInputElement;
  const fetchBtn = p.querySelector('.df-fetch') as HTMLButtonElement;
  let etaSource: 'jira' | 'manual' | null = null;
  fetchBtn.onclick = async () => {
    if (!handlers.hasExtension || !handlers.fetchIssueDates) {
      openGate('fetchEta');
      return;
    }
    const key = jiraInp.value.trim();
    if (!key) {
      jiraInp.focus();
      return;
    }
    fetchBtn.textContent = '…';
    try {
      const info = await handlers.fetchIssueDates(key);
      if (info.targetEnd) {
        etaInp.value = info.targetEnd;
        etaSource = 'jira';
        handlers.toast(
          `<span class="ok">✓</span> 已从 ${key} 读取 Target End 作为 ETA`,
        );
      } else {
        handlers.toast(
          `${key} 尚未填写 Target End，可先留空，后续会持续提醒`,
        );
      }
    } catch (err) {
      handlers.toast(
        err instanceof Error ? err.message : '读取 ETA 失败',
      );
    } finally {
      fetchBtn.textContent = '读取 ETA';
    }
  };
  etaInp.onchange = () => {
    if (etaSource !== 'jira') etaSource = etaInp.value ? 'manual' : null;
  };
  (p.querySelector('.df-cancel') as HTMLButtonElement).onclick = close;
  (p.querySelector('.df-title') as HTMLInputElement).focus();
  (p.querySelector('.df-save') as HTMLButtonElement).onclick = async () => {
    const titleInp = p.querySelector('.df-title') as HTMLInputElement;
    const title = titleInp.value.trim();
    if (!title) {
      titleInp.focus();
      return;
    }
    const jiraKey = jiraInp.value.trim() || null;
    const date = etaInp.value || null;
    await handlers.addMarker({
      op: 'add_marker',
      itemKey: item.key,
      kind: 'dep',
      label: title,
      jiraKey,
      date,
      etaSource: date ? etaSource || 'manual' : null,
    });
    close();
    handlers.toast(
      date
        ? `<span class="ok">✓</span> 已添加外部依赖，ETA ${fmtMD(date)}`
        : '已添加外部依赖 · 缺少 ETA，将在任务条上持续提醒',
    );
  };
}

export function openDepPopover(
  anchor: HTMLElement,
  item: RoadmapItem,
  handlers: MarkerHandlers,
) {
  const deps = (item.markers || []).filter((m) => m.kind === 'dep');
  const rows = deps
    .map((d) => {
      const stale = depStatusIsStale(d);
      const statusChip = d.jiraKey
        ? `<span class="dep-status-cluster${stale ? ' stale' : ''}">
        <span class="dep-tag status">${depStatusChipLabel(d)}</span>
        ${
          handlers.editable
            ? `<button class="dep-refresh${handlers.hasExtension ? '' : ' locked'}" data-id="${d.id}" type="button" data-tip="${
                handlers.hasExtension
                  ? '刷新 Jira 状态和 Target End'
                  : extensionLockTip('fetchEta')
              }">${REFRESH_SVG}</button>`
            : ''
        }
      </span>`
        : '';
      const mismatch = depEtaMismatchesJira(d);
      const canAdopt = canAdoptJiraTargetEnd(d);
      const adoptLabel = canAdopt ? depAdoptLabel(d) : null;
      const etaHtml = d.date
        ? `<span class="dep-eta${mismatch ? ' drift' : ''}">ETA ${fmtMD(d.date)}${
            d.etaSource === 'jira' ? ' · 来自 Jira' : ''
          }${mismatch && d.jiraTargetEnd ? ` · Jira ${fmtMD(d.jiraTargetEnd)}` : ''}</span>`
        : `<span class="dep-eta missing">需要 ETA${
            d.jiraTargetEnd
              ? ` · Jira ${fmtMD(d.jiraTargetEnd)}`
              : d.jiraKey
                ? `<button class="dep-nudge" data-id="${d.id}" type="button">催一下</button>`
                : ''
          }<input class="dep-eta-edit" data-id="${d.id}" type="date"></span>`;
      const actions = [
        d.date
          ? `<input class="dep-eta-edit" data-id="${d.id}" type="date" value="${d.date}">`
          : '',
        canAdopt && handlers.editable && adoptLabel
          ? `<button class="dep-adopt" data-id="${d.id}" type="button">${adoptLabel}</button>`
          : '',
      ]
        .filter(Boolean)
        .join('');
      return `<div class="dep-row" data-id="${d.id}">
      <div class="dep-row-top">
        <span class="dep-title"></span>
        ${handlers.editable ? `<button class="dep-del" data-id="${d.id}" type="button">×</button>` : ''}
      </div>
      <div class="dep-row-meta">
        ${
          d.jiraKey
            ? `<a class="dep-tag jira" href="${jiraBrowseUrl(d.jiraKey, handlers.jiraBaseUrl)}" target="_blank" rel="noopener" data-tip="在 Jira 打开"><span class="dep-jira-key"></span>${EXT_SVG}</a>${statusChip}`
            : `<span class="dep-tag manual">手动</span>`
        }
        ${etaHtml}
        ${actions}
      </div>
    </div>`;
    })
    .join('');
  const { p, close } = floatAt(anchor, 'dep-popover', 320);
  p.innerHTML = `
    <div class="dep-list">${rows || `<div class="owner-none">还没有外部依赖</div>`}</div>
    ${
      handlers.editable
        ? `<div class="divider"></div>
    <div class="owner-item" data-add>${linkIconHtml(10)}<span style="margin-left:7px">添加外部依赖…</span></div>`
        : ''
    }`;
  deps.forEach((d) => {
    const row = p.querySelector(`.dep-row[data-id="${d.id}"]`);
    if (!row) return;
    (row.querySelector('.dep-title') as HTMLElement).textContent = d.label;
    if (d.jiraKey) {
      const keyEl = row.querySelector('.dep-jira-key') as HTMLElement | null;
      if (keyEl) keyEl.textContent = d.jiraKey;
    }
  });
  p.querySelectorAll('.dep-del').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = (b as HTMLElement).dataset.id!;
      close();
      void handlers.deleteMarker({
        op: 'delete_marker',
        markerId: id,
        itemKey: item.key,
      });
      handlers.toast('外部依赖已删除');
    });
  });
  p.querySelectorAll('.dep-nudge').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = (b as HTMLElement).dataset.id!;
      const dep = deps.find((d) => d.id === id);
      if (dep?.jiraKey) window.open(jiraBrowseUrl(dep.jiraKey), '_blank');
    });
  });
  p.querySelectorAll('.dep-eta-edit').forEach((inp) => {
    (inp as HTMLInputElement).onchange = async () => {
      const id = (inp as HTMLInputElement).dataset.id!;
      const dep = deps.find((d) => d.id === id);
      if (!dep) return;
      const value = (inp as HTMLInputElement).value || null;
      await handlers.updateMarker({
        op: 'update_marker',
        markerId: dep.id,
        itemKey: item.key,
        date: value,
        etaSource: value ? 'manual' : null,
        baseVersion: dep.version,
      });
      close();
    };
  });
  p.querySelectorAll('.dep-adopt').forEach((b) => {
    b.addEventListener('pointerdown', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = (b as HTMLElement).dataset.id!;
      const dep = deps.find((d) => d.id === id);
      if (!dep?.jiraTargetEnd) return;
      await handlers.updateMarker({
        op: 'update_marker',
        markerId: dep.id,
        itemKey: item.key,
        date: dep.jiraTargetEnd,
        etaSource: 'jira',
        baseVersion: dep.version,
      });
      handlers.toast(
        `<span class="ok">✓</span> 已把 ${dep.jiraKey} 的 Target End 设为 ETA ${fmtMD(dep.jiraTargetEnd)}`,
      );
      close();
    });
  });
  p.querySelectorAll('.dep-refresh').forEach((b) => {
    b.addEventListener('pointerdown', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = (b as HTMLElement).dataset.id!;
      const dep = deps.find((d) => d.id === id);
      if (!dep?.jiraKey) return;
      if (!handlers.hasExtension || !handlers.fetchIssueDates) {
        openGate('fetchEta');
        return;
      }
      try {
        const info = await handlers.fetchIssueDates(dep.jiraKey);
        await handlers.updateMarker({
          op: 'update_marker',
          markerId: dep.id,
          itemKey: item.key,
          jiraStatus: info.status,
          jiraTargetEnd: info.targetEnd,
          baseVersion: dep.version,
        });
        const bits = [
          info.status || '未刷新',
          info.targetEnd ? `Target End ${fmtMD(info.targetEnd)}` : '无 Target End',
        ];
        handlers.toast(
          info.status
            ? `<span class="ok">✓</span> 已同步 ${dep.jiraKey} · ${bits.join(' · ')}。${
                info.targetEnd && info.targetEnd !== dep.date
                  ? '单击 🔗 可把该日期设为 ETA。'
                  : ''
              }`
            : `已读到 ${dep.jiraKey} 的日期，但状态仍未返回。请重新加载 Personal AI 扩展后再点刷新。`,
        );
        close();
      } catch (err) {
        handlers.toast(err instanceof Error ? err.message : '刷新失败');
      }
    });
  });
  p.querySelector('[data-add]')?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
    openDepForm(anchor, item, handlers);
  });
}

/** ISO date string comparison against today. */
export function isMarkerDone(date: string | null | undefined): boolean {
  if (!date) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt < today;
}
