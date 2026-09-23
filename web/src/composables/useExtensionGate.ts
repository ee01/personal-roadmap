import { ref } from 'vue';

export const EXTENSION_STORE_URL =
  'https://chromewebstore.google.com/detail/personal-ai/kefnadjndpllbibeklhajjddgmlbafel';

/** Actions that can only run through the extension (they need the user's own Jira session). */
export type ExtensionFeature =
  | 'import'
  | 'importTasks'
  | 'createJira'
  | 'fetchEta'
  | 'syncJira';

export const EXTENSION_FEATURES: Record<
  ExtensionFeature,
  { label: string; why: string }
> = {
  import: {
    label: '导入 Backlog',
    why: '把 JQL 结果拉进 Backlog，需要扩展用你自己的 Jira 账号执行查询——服务端没有你的 Jira 权限。',
  },
  importTasks: {
    label: '导入 Task',
    why: '读取各主任务名下的 Task，需要扩展用你自己的 Jira 账号执行查询。',
  },
  createJira: {
    label: '创建 Jira',
    why: '把草稿任务写回 Jira，需要扩展用你自己的 Jira 账号创建 issue，这样 reporter 才是你本人。',
  },
  fetchEta: {
    label: '读取 ETA',
    why: '读取外部依赖 issue 的 Target End，需要扩展用你自己的 Jira 账号访问该 issue。',
  },
  syncJira: {
    label: '回写 Jira',
    why: '把排期（Target Start/End）和 Owner 写回 issue，需要扩展用你自己的 Jira 账号执行——Roadmap 上的改动已经保存，只是没有同步到 Jira。',
  },
};

/** One-line snackbar after a Jira write is skipped because the extension is missing. */
export const JIRA_WRITE_SKIPPED_TEXT =
  '这次改动只保存在 Roadmap，没有同步到 Jira。';
export const JIRA_WRITE_SKIPPED_ACTION = '安装插件开启同步';

export const EXTENSION_PERKS: Array<{
  key: ExtensionFeature | 'identity';
  title: string;
  desc: string;
}> = [
  {
    key: 'import',
    title: '导入 Backlog',
    desc: '按 JQL + Quarter 把 Jira issue 拉进 Backlog',
  },
  {
    key: 'importTasks',
    title: '导入 Task',
    desc: '拉取主任务名下的 Task，按 Jira Key 去重落位',
  },
  {
    key: 'createJira',
    title: '创建 Jira',
    desc: '草稿任务一键写回 Jira（直连 API 或 Agent 执行器）',
  },
  {
    key: 'fetchEta',
    title: '读取 ETA',
    desc: '外部依赖自动读取 Target End，缺 ETA 的红色提醒随之消失',
  },
  {
    key: 'syncJira',
    title: '回写 Jira',
    desc: '拖动排期写回 Target Start/End，改 Owner 写回 assignee',
  },
  {
    key: 'identity',
    title: '自动识别身份',
    desc: '免去手动填名字，协作日志直接署你的实名',
  },
];

/** `data-tip` payload (head||body||hint) for a button locked behind the extension. */
export function extensionLockTip(feature: ExtensionFeature): string {
  return [
    '需要 Personal AI 扩展',
    `「${EXTENSION_FEATURES[feature].label}」由扩展用你自己的 Jira 账号执行`,
    '点击查看安装指引',
  ].join('||');
}

const gateOpen = ref(false);
const gateFeature = ref<ExtensionFeature>('createJira');
const writeNoticeOpen = ref(false);
let writeNoticeTimer: number | null = null;

function hideWriteNotice() {
  writeNoticeOpen.value = false;
  if (writeNoticeTimer != null) {
    window.clearTimeout(writeNoticeTimer);
    writeNoticeTimer = null;
  }
}

/** After a local edit that would have written Jira. Singleton; resets hide timer. */
function showWriteNotice() {
  writeNoticeOpen.value = true;
  if (writeNoticeTimer != null) window.clearTimeout(writeNoticeTimer);
  writeNoticeTimer = window.setTimeout(() => {
    writeNoticeTimer = null;
    writeNoticeOpen.value = false;
  }, 10000);
}

/**
 * Gate for extension-only actions. Instead of a `disabled` button that cannot
 * explain itself, callers keep the button clickable and route through here:
 * when the extension is missing the install guide opens and the action stops.
 * Prompt only on the user's own click — no always-on banner.
 *
 * Jira *writes* that already committed locally (drag Target, change Owner)
 * use `showWriteNotice()` instead of blocking the edit.
 */
export function useExtensionGate() {
  function openGate(feature: ExtensionFeature) {
    gateFeature.value = feature;
    gateOpen.value = true;
  }

  function closeGate() {
    gateOpen.value = false;
  }

  function openStore() {
    window.open(EXTENSION_STORE_URL, '_blank', 'noopener');
  }

  function openWriteNoticeInstall() {
    hideWriteNotice();
    openGate('syncJira');
  }

  return {
    gateOpen,
    gateFeature,
    writeNoticeOpen,
    openGate,
    closeGate,
    openStore,
    showWriteNotice,
    hideWriteNotice,
    openWriteNoticeInstall,
  };
}
