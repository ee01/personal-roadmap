import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const jiraBaseUrl = (process.env.JIRA_BASE_URL || '').trim();
const jiraPat = (process.env.JIRA_PAT || '').trim();

function envFlag(name: string, fallback = false): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function parseProvider(): 'openai' | 'claude' {
  const raw = (process.env.ROADMAP_LLM_PROVIDER || 'openai').trim().toLowerCase();
  if (raw === 'openai' || raw === 'claude') return raw;
  throw new Error(`ROADMAP_LLM_PROVIDER must be openai or claude, got ${raw}`);
}

const openaiBase = (process.env.ROADMAP_OPENAI_API_BASE_URL || 'https://api.openai.com/v1').trim();

export const DEFAULT_PUBLIC_BASE_URL = 'http://roadmap.xmnup.com';

export const config = {
  port: Number(process.env.PORT) || 3220,
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, '../data'),
  publicBaseUrl: (process.env.ROADMAP_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).trim(),
  softLockTtlMs: Number(process.env.SOFT_LOCK_TTL_MS) || 30_000,
  activityRetentionDays: Number(process.env.ACTIVITY_RETENTION_DAYS) || 90,
  jira: {
    baseUrl: jiraBaseUrl,
    pat: jiraPat,
    fieldTargetStart:
      process.env.JIRA_FIELD_TARGET_START || 'customfield_18350',
    fieldTargetEnd: process.env.JIRA_FIELD_TARGET_END || 'customfield_18351',
    enabled: Boolean(jiraBaseUrl && jiraPat),
  },
  ai: {
    enabled: envFlag('ROADMAP_AI_ENABLED', false),
    agentAccess: envFlag('ROADMAP_AI_AGENT_ACCESS', true),
    provider: (process.env.ROADMAP_LLM_PROVIDER || 'openai').trim().toLowerCase() === 'claude'
      ? ('claude' as const)
      : ('openai' as const),
    openai: {
      apiKey: (process.env.ROADMAP_OPENAI_API_KEY || '').trim(),
      baseUrl: openaiBase.replace(/\/+$/, ''),
      model: (process.env.ROADMAP_OPENAI_MODEL || 'gpt-4.1').trim(),
      apiMode: (process.env.ROADMAP_OPENAI_API_MODE || 'chat_completions').trim() === 'responses'
        ? ('responses' as const)
        : ('chat_completions' as const),
      outputMode: (process.env.ROADMAP_OPENAI_OUTPUT_MODE || 'json_schema').trim() as
        | 'json_schema'
        | 'json_object'
        | 'prompt_json',
    },
    claude: {
      apiKey: (process.env.ROADMAP_CLAUDE_API_KEY || '').trim(),
      model: (process.env.ROADMAP_CLAUDE_MODEL || 'claude-sonnet-4-5').trim(),
    },
    requestTimeoutMs: Number(process.env.ROADMAP_LLM_REQUEST_TIMEOUT_MS) || 60_000,
    jobTimeoutMs: Number(process.env.ROADMAP_AI_JOB_TIMEOUT_MS) || 120_000,
    maxAttempts: Number(process.env.ROADMAP_LLM_MAX_ATTEMPTS) || 2,
    maxOutputTokens: Number(process.env.ROADMAP_LLM_MAX_OUTPUT_TOKENS) || 16_384,
  },
};

export function assertLlmProviderConfigured(): void {
  parseProvider();
}

export function llmConfigured(): boolean {
  if (config.ai.provider === 'claude') return Boolean(config.ai.claude.apiKey);
  return Boolean(config.ai.openai.apiKey);
}

export function configurationVersion(): string {
  const identity =
    config.ai.provider === 'claude'
      ? `claude:${config.ai.claude.model}`
      : `openai:${config.ai.openai.model}:${config.ai.openai.baseUrl}:${config.ai.openai.apiMode}:${config.ai.openai.outputMode}`;
  return identity;
}

export function providerDisplayName(): string | null {
  if (!config.ai.enabled) return null;
  return config.ai.provider === 'claude' ? 'Claude' : 'OpenAI';
}

export function endpointDisplayName(): string | null {
  if (!config.ai.enabled) return null;
  if (config.ai.provider === 'claude') return 'api.anthropic.com';
  try {
    return new URL(
      config.ai.openai.baseUrl.startsWith('http')
        ? config.ai.openai.baseUrl
        : `https://${config.ai.openai.baseUrl}`,
    ).host;
  } catch {
    return 'openai-compatible';
  }
}

