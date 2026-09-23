<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoadmapState } from '../../composables/useRoadmapState';
import {
  PHASE_RULER,
  applyReleaseFilter,
  buildReleaseSheetConfig,
  extractSheetId,
  fetchReleaseSheetRows,
  filterKey,
  fmtISO,
  isMajorRelease,
  normFilter,
  parseReleaseRows,
  phaseKind,
  phaseOptions,
  pickSplit,
  relParsed,
  type PhaseOption,
  type PhaseRulerKind,
  type ReleaseFilter,
  type ReleaseFilterMode,
} from '../../composables/useReleaseRuler';

const CHECK_SVG =
  '<svg width="8" height="8" viewBox="0 0 10 10"><path d="M1.5 5.5L4 8l4.5-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** Finish-side flag (pole on the right): marks the exclusive end / handoff of a Sprint band. */
const END_FLAG_SVG =
  '<svg viewBox="0 0 14 14"><path d="M10.8 12.5V2M10.8 2.5H4l1.9 2.6L4 7.5h6.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

const state = useRoadmapState();
const jql = ref('');
const sheetUrl = ref('');
const sheetName = ref('Sheet1');
const sheetRange = ref('A1:C500');
const saving = ref(false);
const loadingSheet = ref(false);
const clearing = ref(false);

const modalRows = ref<Array<Record<string, unknown>> | null>(null);
const modalSplitSel = ref<PhaseRulerKind | null>(null);
const modalShowSel = ref<PhaseRulerKind[] | null>(null);
const modalFilterSel = ref<ReleaseFilter | null>(null);
const modalLoadKey = ref<string | null>(null);
let autoLoadTimer: ReturnType<typeof setTimeout> | null = null;
let filterPreviewTimer: ReturnType<typeof setTimeout> | null = null;
const filterPatternDraft = ref('');

const egVisible = ref(false);
const egStyle = ref<Record<string, string>>({});

const configured = computed(
  () => Boolean(state.snapshot.value?.team.releaseSheet),
);

const cfgKey = computed(() =>
  [sheetUrl.value.trim(), sheetName.value.trim(), sheetRange.value.trim()].join(
    '|',
  ),
);

const fullParsed = computed(() =>
  modalRows.value?.length ? parseReleaseRows(modalRows.value) : null,
);

const phaseOpts = computed<PhaseOption[]>(() => {
  if (!fullParsed.value) return [];
  return phaseOptions(fullParsed.value);
});

const effectiveFilter = computed(() =>
  normFilter(
    modalFilterSel.value || { mode: 'all', pattern: filterPatternDraft.value },
  ),
);

const filterResult = computed(() => {
  if (!fullParsed.value) return null;
  return applyReleaseFilter(fullParsed.value, effectiveFilter.value);
});

const filterModes = computed(() => {
  const total = fullParsed.value?.releases.length || 0;
  const majorN = fullParsed.value
    ? fullParsed.value.releases.filter((r) => isMajorRelease(r.name)).length
    : 0;
  return [
    { m: 'all' as ReleaseFilterMode, label: '全部', n: total as number | null },
    {
      m: 'major' as ReleaseFilterMode,
      label: '仅大版本（尾号 0）',
      n: majorN as number | null,
    },
    { m: 'custom' as ReleaseFilterMode, label: '自定义', n: null },
  ];
});

const effectiveSplit = computed(() => {
  if (!fullParsed.value) return null;
  // Split chips use full table kinds; save path re-validates against filtered.
  return pickSplit(modalSplitSel.value, fullParsed.value);
});

const shownSet = computed(() => {
  if (!fullParsed.value || !effectiveSplit.value) {
    return new Set<PhaseRulerKind>();
  }
  const opts = phaseOpts.value;
  let show = modalShowSel.value;
  if (!show) show = opts.map((o) => o.kind);
  if (!show.includes(effectiveSplit.value)) {
    show = [...show, effectiveSplit.value];
  }
  return new Set(show);
});

const shownCount = computed(() => {
  if (!phaseOpts.value.length) return 0;
  return phaseOpts.value.filter((o) => shownSet.value.has(o.kind)).length;
});

const previewRows = computed(() => (modalRows.value || []).slice(0, 5));
const previewSummary = computed(() => {
  if (!fullParsed.value) return null;
  if (!fullParsed.value.releases.length) return { empty: true as const };
  return {
    empty: false as const,
    rows: modalRows.value!.length,
    releases: fullParsed.value.releases.length,
    from: fmtISO(fullParsed.value.releases[0].start),
    to: fmtISO(
      fullParsed.value.releases[fullParsed.value.releases.length - 1].end,
    ),
  };
});

function resetModalFromTeam() {
  const team = state.snapshot.value?.team;
  jql.value = team?.jql || '';
  const rs = team?.releaseSheet || null;
  sheetUrl.value = rs?.url || '';
  sheetName.value = rs?.sheetName || 'Sheet1';
  sheetRange.value = rs?.range || 'A1:C500';
  modalRows.value = rs?.rows?.length ? [...rs.rows] : null;
  modalSplitSel.value = (rs?.splitPhase as PhaseRulerKind) || null;
  modalShowSel.value = rs?.showPhases
    ? ([...rs.showPhases] as PhaseRulerKind[])
    : null;
  modalFilterSel.value = rs?.releaseFilter
    ? { ...normFilter(rs.releaseFilter) }
    : null;
  filterPatternDraft.value = rs?.releaseFilter?.pattern || '';
  modalLoadKey.value = rs
    ? [rs.url, rs.sheetName, rs.range].join('|')
    : null;
  if (autoLoadTimer) clearTimeout(autoLoadTimer);
  if (filterPreviewTimer) clearTimeout(filterPreviewTimer);
}

watch(
  () => state.modals.value.jql,
  (open) => {
    if (open) resetModalFromTeam();
  },
);

watch([sheetUrl, sheetName, sheetRange], () => {
  if (!state.modals.value.jql) return;
  scheduleAutoLoad();
});

function scheduleAutoLoad() {
  if (autoLoadTimer) clearTimeout(autoLoadTimer);
  const key = cfgKey.value;
  if (!sheetUrl.value.trim() || key === modalLoadKey.value) return;
  autoLoadTimer = setTimeout(() => {
    void loadSheetIntoModal(key);
  }, 600);
}

async function loadSheetIntoModal(key: string, opts: { force?: boolean } = {}) {
  if (!sheetUrl.value.trim()) return;
  const spreadsheetId = extractSheetId(sheetUrl.value);
  if (!spreadsheetId) {
    state.toast('无法从地址解析 spreadsheetId');
    return;
  }
  loadingSheet.value = true;
  modalLoadKey.value = key;
  try {
    const rows = await fetchReleaseSheetRows({
      spreadsheetId,
      sheetName: sheetName.value.trim() || 'Sheet1',
      range: sheetRange.value.trim() || 'A1:C500',
    });
    if (!opts.force && cfgKey.value !== key) return;
    modalRows.value = rows;
    modalShowSel.value = null;
    modalSplitSel.value = null;
    modalFilterSel.value = null;
    filterPatternDraft.value = '';
  } catch {
    if (cfgKey.value === key) {
      state.toast('读取发布时间表失败，请检查表格权限与格式');
    }
  } finally {
    loadingSheet.value = false;
  }
}

function ensureShowSel(opts: PhaseOption[], split: PhaseRulerKind) {
  if (!modalShowSel.value) {
    modalShowSel.value = opts.map((o) => o.kind);
  }
  if (!modalShowSel.value.includes(split)) {
    modalShowSel.value = [...modalShowSel.value, split];
  }
}

function isShown(kind: PhaseRulerKind) {
  return shownSet.value.has(kind);
}

function toggleShow(kind: PhaseRulerKind) {
  const split = effectiveSplit.value;
  if (!split) return;
  if (kind === split) {
    state.toast('结束分割节点必须在标尺上展示 —— 先把 🏁 移到别的阶段');
    return;
  }
  ensureShowSel(phaseOpts.value, split);
  const cur = modalShowSel.value || [];
  modalShowSel.value = cur.includes(kind)
    ? cur.filter((k) => k !== kind)
    : [...cur, kind];
}

function setFilterMode(mode: ReleaseFilterMode) {
  modalFilterSel.value = {
    mode,
    pattern:
      mode === 'custom'
        ? filterPatternDraft.value || modalFilterSel.value?.pattern || ''
        : '',
  };
  if (mode !== 'custom') filterPatternDraft.value = '';
}

function onFilterPatternInput(ev: Event) {
  const value = (ev.target as HTMLInputElement).value;
  filterPatternDraft.value = value;
  if (filterPreviewTimer) clearTimeout(filterPreviewTimer);
  filterPreviewTimer = setTimeout(() => {
    modalFilterSel.value = { mode: 'custom', pattern: value };
  }, 350);
}

function setSplit(kind: PhaseRulerKind) {
  modalSplitSel.value = kind;
  ensureShowSel(phaseOpts.value, kind);
}

async function reread() {
  if (!sheetUrl.value.trim()) return;
  if (autoLoadTimer) clearTimeout(autoLoadTimer);
  await loadSheetIntoModal(cfgKey.value, { force: true });
}

async function clearReleaseSheet() {
  if (!state.editable.value || clearing.value) return;
  clearing.value = true;
  try {
    await state.applySnapshotFromIntent({
      op: 'update_release_sheet',
      releaseSheet: null,
    });
    sheetUrl.value = '';
    sheetName.value = 'Sheet1';
    sheetRange.value = 'A1:C500';
    modalRows.value = null;
    modalSplitSel.value = null;
    modalShowSel.value = null;
    modalFilterSel.value = null;
    filterPatternDraft.value = '';
    modalLoadKey.value = null;
    state.toast('已清除发布时间表，标尺恢复为月份');
  } catch {
    /* handled */
  } finally {
    clearing.value = false;
  }
}

function showEg(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  egStyle.value = {
    left: `${Math.min(r.left, window.innerWidth - 360)}px`,
    top: `${r.bottom + 8}px`,
  };
  egVisible.value = true;
}

function hideEg() {
  egVisible.value = false;
}

async function save() {
  if (!jql.value.trim() || !state.snapshot.value || saving.value) return;
  saving.value = true;
  try {
    const url = sheetUrl.value.trim();
    const prev = state.snapshot.value.team.releaseSheet || null;

    if (url) {
      const sameSrc =
        prev &&
        prev.rows?.length &&
        prev.url === url &&
        prev.sheetName === (sheetName.value.trim() || 'Sheet1') &&
        prev.range === (sheetRange.value.trim() || 'A1:C500');

      if (sameSrc && prev) {
        const filt = normFilter({
          mode: modalFilterSel.value?.mode || 'all',
          pattern:
            modalFilterSel.value?.mode === 'custom'
              ? filterPatternDraft.value || modalFilterSel.value.pattern || ''
              : modalFilterSel.value?.pattern || '',
        });
        const cfg = buildReleaseSheetConfig({
          url: prev.url,
          sheetName: prev.sheetName,
          range: prev.range,
          splitPhase: modalSplitSel.value,
          showPhases: modalShowSel.value,
          releaseFilter: filt,
          rows: prev.rows,
        });
        if (!cfg) {
          state.toast('发布时间表无有效数据，请检查表格格式');
          return;
        }
        cfg.fetchedAt = prev.fetchedAt;
        const changed =
          filterKey(filt) !== filterKey(prev.releaseFilter) ||
          cfg.splitPhase !== prev.splitPhase ||
          cfg.showPhases.join() !== (prev.showPhases || []).join();
        await state.applySnapshotFromIntent({
          op: 'update_jql',
          jql: jql.value.trim(),
          releaseSheet: cfg,
        });
        state.modals.value.jql = false;
        const kept = relParsed(cfg).releases.length;
        state.toast(
          changed
            ? `<span class="ok">✓</span> 标尺配置已更新 · 结束于「${PHASE_RULER[cfg.splitPhase as PhaseRulerKind].label}」· 保留 ${kept} 个 release · 展示 ${cfg.showPhases.length} 个阶段`
            : '<span class="ok">✓</span> 配置已保存',
        );
        return;
      }

      let rows =
        modalRows.value && modalLoadKey.value === cfgKey.value
          ? modalRows.value
          : null;
      if (!rows) {
        const spreadsheetId = extractSheetId(url);
        rows = await fetchReleaseSheetRows({
          spreadsheetId,
          sheetName: sheetName.value.trim() || 'Sheet1',
          range: sheetRange.value.trim() || 'A1:C500',
        });
      }
      const filt = normFilter({
        mode: modalFilterSel.value?.mode || 'all',
        pattern:
          modalFilterSel.value?.mode === 'custom'
            ? filterPatternDraft.value || modalFilterSel.value.pattern || ''
            : modalFilterSel.value?.pattern || '',
      });
      const cfg = buildReleaseSheetConfig({
        url,
        sheetName: sheetName.value,
        range: sheetRange.value,
        splitPhase: modalSplitSel.value,
        showPhases: modalShowSel.value,
        releaseFilter: filt,
        rows,
      });
      if (!cfg) {
        state.toast(
          '未解析到有效数据 —— 请确认前三列为 Release / Phase / Date 且第一行为表头',
        );
        return;
      }
      await state.applySnapshotFromIntent({
        op: 'update_jql',
        jql: jql.value.trim(),
        releaseSheet: cfg,
      });
      state.modals.value.jql = false;
      const kept = relParsed(cfg).releases.length;
      state.toast(
        `<span class="ok">✓</span> 已读取 <b>${cfg.rows.length}</b> 条发布计划 · 保留 ${kept} 个 release` +
          ` · 结束于「${PHASE_RULER[cfg.splitPhase as PhaseRulerKind].label}」· 展示 ${cfg.showPhases.length} 个阶段`,
      );
      return;
    }

    const had = Boolean(prev);
    await state.applySnapshotFromIntent({
      op: 'update_jql',
      jql: jql.value.trim(),
      releaseSheet: null,
    });
    state.modals.value.jql = false;
    state.toast(
      had
        ? 'JQL 已更新 · 发布时间表已移除，标尺恢复月份'
        : '<span class="ok">✓</span> JQL 已更新，下次导入按新 JQL 执行',
    );
  } catch {
    /* handled */
  } finally {
    saving.value = false;
  }
}

onUnmounted(() => {
  if (autoLoadTimer) clearTimeout(autoLoadTimer);
  if (filterPreviewTimer) clearTimeout(filterPreviewTimer);
});
</script>

<template>
  <div
    class="modal-back"
    :class="{ show: state.modals.value.jql }"
    @click.self="state.modals.value.jql = false"
  >
    <div class="modal modal-jql">
      <div class="m-head">
        <div class="m-title">编辑团队 JQL</div>
        <div class="m-sub">
          修改仅影响<b>之后的导入</b>；已导入数据与排期不受影响。若 JQL 含
          <b style="font-family: var(--mono)">"Target Delivery Quarter" in (...)</b>，导入时会用勾选的
          quarters 替换该子句；不含该字段时不显示 quarters 勾选，直接按原 JQL 导入。
        </div>
      </div>
      <div class="m-body">
        <label class="f-label">数据源 JQL</label>
        <textarea v-model="jql" class="f-input" style="min-height: 140px" />

        <div class="cfg-sec">
          <div class="cfg-sec-head">
            <span class="cfg-sec-title"
              >发布时间表标尺<span class="new-badge">NEW</span></span
            >
            <span
              class="hover-eg"
              @mouseenter="showEg"
              @mouseleave="hideEg"
              >悬停查看示例表格</span
            >
          </div>
          <div class="m-sub" style="margin-top: 6px">
            团队若维护了<b>发布时间表</b>（Google Sheet 二维表，三列
            <b style="font-family: var(--mono)">Release / Phase / Date</b
            >，第一行为表头），填入表格地址后， 甘特图时间标尺将按<b>发布 Sprint</b
            >展示；留空则使用默认月份标尺。
          </div>
          <label class="f-label">Google Sheet 地址（或 spreadsheetId）</label>
          <input
            v-model="sheetUrl"
            class="f-input"
            placeholder="https://docs.google.com/spreadsheets/d/1sWRtByTquVLKeyv…/edit"
          />
          <div class="f-grid">
            <div>
              <label class="f-label">Sheet 名称</label>
              <input
                v-model="sheetName"
                class="f-input"
                placeholder="2026 phases"
              />
            </div>
            <div>
              <label class="f-label">数据范围</label>
              <input
                v-model="sheetRange"
                class="f-input"
                placeholder="A1:C500"
              />
            </div>
          </div>

          <label class="f-label"
            >标尺阶段<span class="lb-tip"
              >勾选 = 在标尺上展示 · 🏁 = 作为 release 结束分割节点</span
            ></label
          >

          <div v-if="loadingSheet" class="pp-empty">
            <span class="mini-spin" /> 正在读取表格，加载可选阶段…
          </div>
          <div v-else-if="!phaseOpts.length" class="pp-empty">
            填入表格地址后<b>自动读取</b>，这里会列出表中出现的阶段供勾选。<br />
            未加载就直接保存也可以：保存时会自动读取，并按默认 ——
            <b>FF 作结束分界</b>（无 FF 则取周期内最早的阶段）、
            <b>全部阶段都展示</b>。
          </div>
          <template v-else>
            <div class="phase-pick">
              <div
                v-for="o in phaseOpts"
                :key="o.kind"
                class="pp-chip"
                :class="{
                  on: isShown(o.kind),
                  off: !isShown(o.kind),
                  split: effectiveSplit === o.kind,
                }"
                :data-tip="
                  (effectiveSplit === o.kind
                    ? '结束分割节点 · 必定展示'
                    : isShown(o.kind)
                      ? '已展示，点击隐藏'
                      : '已隐藏，点击展示') +
                  `||${PHASE_RULER[o.kind].full}||🏁 设为 release 结束分割节点`
                "
                @click="toggleShow(o.kind)"
              >
                <span class="pp-box" v-html="CHECK_SVG" />
                <span
                  class="pp-dot"
                  :style="{ background: PHASE_RULER[o.kind].color }"
                />
                {{ o.raw }}
                <span class="pp-n">×{{ o.count }}</span>
                <button
                  type="button"
                  class="pp-split"
                  @click.stop="setSplit(o.kind)"
                  v-html="
                    END_FLAG_SVG + (effectiveSplit === o.kind ? '结束' : '')
                  "
                />
              </div>
            </div>
            <div v-if="effectiveSplit" class="pp-foot">
              🏁
              <b>{{ PHASE_RULER[effectiveSplit].label }}</b> 作为 Sprint
              结束分界：每列 Sprint 到它结束、从上一班的它开始（半开区间，切换日落在下一列）；
              没有该阶段的 release（如 RIO 热修）不单独成列，以刻度叠加在所在
              Sprint 内。 标尺上展示
              <b>{{ shownCount }}/{{ phaseOpts.length }}</b> 个阶段{{
                shownCount < phaseOpts.length
                  ? '（未勾选的不画刻度与竖线）'
                  : ''
              }}。
            </div>
          </template>

          <label class="f-label"
            >Release 过滤<span class="lb-tip"
              >小版本多时只保留关键 release，标尺更干净</span
            ></label
          >
          <div v-if="!fullParsed" class="pp-empty">
            读取数据后可配置：例如只保留 <b>26.3.320</b> 这类尾号 0 的大版本，
            过滤 <b>26.3.325</b> 这类小版本。
          </div>
          <template v-else>
            <div class="rf-chips">
              <button
                v-for="o in filterModes"
                :key="o.m"
                type="button"
                class="rf-chip"
                :class="{
                  on: (modalFilterSel?.mode || 'all') === o.m,
                }"
                @click="setFilterMode(o.m)"
              >
                {{ o.label
                }}<span v-if="o.n != null" class="pp-n">×{{ o.n }}</span>
              </button>
            </div>
            <div
              v-if="(modalFilterSel?.mode || 'all') === 'custom'"
              class="rf-input-row"
            >
              <input
                class="f-input rf-input"
                :value="filterPatternDraft"
                placeholder="通配符，逗号分隔任一匹配即保留：*0 = 尾号 0；26.4.* = 26.4 系列；/…/ 按正则"
                @input="onFilterPatternInput"
              />
              <div class="df-hint" style="margin-top: 6px">
                匹配的 release <b>保留</b>在标尺上；也可以用
                <b style="font-family: var(--mono)">/\d0$/</b>
                这类正则（斜杠包裹）。
              </div>
            </div>
            <div v-if="filterResult?.invalid" class="rf-warn">
              规则无法解析（检查正则写法），当前<b>视为不过滤</b>，全部 release
              保留。
            </div>
            <div v-else-if="filterResult?.empty" class="rf-warn">
              该规则会把所有 release 都过滤掉，已<b>兜底为不过滤</b> ——
              请调整规则。
            </div>
            <div v-else-if="filterResult" class="rf-preview">
              ✓ 保留 <b>{{ filterResult.parsed.releases.length }}</b> 个
              <template v-if="filterResult.dropped.length">
                · ✕ 过滤 <b>{{ filterResult.dropped.length }}</b> 个：
                <span
                  v-for="n in filterResult.dropped.slice(0, 8)"
                  :key="n"
                  class="rf-out"
                  >{{ n }}</span
                >
                <template v-if="filterResult.dropped.length > 8">
                  …等 {{ filterResult.dropped.length }} 个
                </template>
              </template>
              <template v-else> · 没有 release 被过滤</template>
            </div>
          </template>

          <div class="sheet-test-row">
            <button
              class="btn btn-ghost"
              :disabled="loadingSheet || !sheetUrl.trim()"
              @click="reread"
            >
              <span v-if="loadingSheet" class="mini-spin" />
              {{ loadingSheet ? '读取中…' : '重新读取' }}
            </button>
            <button
              v-show="configured"
              class="sheet-clear"
              :disabled="!state.editable.value || clearing"
              @click="clearReleaseSheet"
            >
              清除配置，恢复月份标尺
            </button>
          </div>

          <div v-if="previewSummary" class="sheet-preview">
            <template v-if="previewSummary.empty">
              <div class="sheet-sum" style="border-top: none">
                未解析到有效数据 —— 请确认前三列为
                <b>Release / Phase / Date</b> 且第一行为表头
              </div>
            </template>
            <template v-else>
              <table>
                <tr>
                  <th>Release</th>
                  <th>Phase</th>
                  <th>Date</th>
                </tr>
                <tr v-for="(r, i) in previewRows" :key="i">
                  <td style="font-family: var(--mono); font-size: 11px">
                    {{ String(r.Release ?? '') }}
                  </td>
                  <td>
                    <span class="ph-chip">
                      <i
                        :style="{
                          background: PHASE_RULER[phaseKind(r.Phase)].color,
                        }"
                      />
                      {{ String(r.Phase ?? '') }}
                    </span>
                  </td>
                  <td style="font-family: var(--mono); font-size: 11px">
                    {{
                      Number.isNaN(new Date(String(r.Date ?? '')).getTime())
                        ? ''
                        : fmtISO(new Date(String(r.Date ?? '')))
                    }}
                  </td>
                </tr>
              </table>
              <div class="sheet-sum">
                共 <b>{{ previewSummary.rows }}</b> 行 ·
                <b>{{ previewSummary.releases }}</b> 个 release · 覆盖
                <b>{{ previewSummary.from }}</b> →
                <b>{{ previewSummary.to }}</b>
              </div>
            </template>
          </div>
        </div>
      </div>
      <div class="m-foot">
        <button class="btn btn-ghost" @click="state.modals.value.jql = false">
          取消
        </button>
        <button
          class="btn btn-primary"
          :disabled="!state.editable.value || saving"
          @click="save"
        >
          <span v-if="saving" class="mini-spin" />
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>

  <div class="sheet-eg-pop" :class="{ show: egVisible }" :style="egStyle">
    <table class="fake-sheet">
      <tr>
        <th />
        <th>A</th>
        <th>B</th>
        <th>C</th>
      </tr>
      <tr class="hd">
        <td>1</td>
        <td>Release</td>
        <td>Phase</td>
        <td>Date</td>
      </tr>
      <tr>
        <td>2</td>
        <td>26.3.130</td>
        <td>FF</td>
        <td class="num">2026-07-27</td>
      </tr>
      <tr>
        <td>3</td>
        <td>26.3.130</td>
        <td>Re</td>
        <td class="num">2026-07-30</td>
      </tr>
      <tr>
        <td>4</td>
        <td>26.3.130</td>
        <td>Stage</td>
        <td class="num">2026-07-31</td>
      </tr>
      <tr>
        <td>5</td>
        <td>26.3.130</td>
        <td>Pro</td>
        <td class="num">2026-08-05</td>
      </tr>
      <tr>
        <td>6</td>
        <td>26.3.130</td>
        <td>Multi-region</td>
        <td class="num">2026-08-07</td>
      </tr>
    </table>
    <div class="sheet-eg-cap">
      三列固定表头 <b>Release / Phase / Date</b>，同一 release
      每个阶段一行。Date 为日期（UTC ISO 亦可）。RIO 热修可只有 Pro。
    </div>
  </div>
</template>
