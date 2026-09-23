import { config } from '../config.js';
import type { DraftPlanV1 } from '../planning/contracts.js';
import {
  buildPlanningPrompt,
  type LlmGenerateInput,
  type LlmGenerateResult,
} from './RoadmapLlmClient.js';

function normalizeOpenAiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions') || trimmed.endsWith('/responses')) {
    return trimmed.replace(/\/(chat\/completions|responses)$/, '');
  }
  return trimmed;
}

export async function generateWithOpenAi(
  input: LlmGenerateInput,
): Promise<LlmGenerateResult> {
  if (!config.ai.openai.apiKey) {
    throw Object.assign(new Error('provider_unconfigured'), {
      errorCode: 'provider_unconfigured',
    });
  }
  const prompt = buildPlanningPrompt(input);
  const root = normalizeOpenAiRoot(config.ai.openai.baseUrl);
  const url =
    config.ai.openai.apiMode === 'responses'
      ? `${root}/responses`
      : `${root}/chat/completions`;
  const body =
    config.ai.openai.apiMode === 'responses'
      ? {
          model: config.ai.openai.model,
          input: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          max_output_tokens: config.ai.maxOutputTokens,
          text: { format: { type: 'json_object' } },
        }
      : {
          model: config.ai.openai.model,
          temperature: 0,
          max_tokens: config.ai.maxOutputTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.ai.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error('provider_unauthorized'), {
      errorCode: 'provider_refused',
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`provider_http_${response.status}`), {
      errorCode: response.status === 429 ? 'provider_refused' : 'provider_invalid_json',
    });
  }
  const json = (await response.json()) as Record<string, unknown>;
  const text = extractOpenAiText(json);
  if (!text) {
    throw Object.assign(new Error('empty_response'), {
      errorCode: 'provider_invalid_json',
    });
  }
  let parsed: DraftPlanV1;
  try {
    parsed = JSON.parse(text) as DraftPlanV1;
  } catch {
    throw Object.assign(new Error('invalid_json'), {
      errorCode: 'provider_invalid_json',
    });
  }
  const usage = (json.usage || {}) as Record<string, number>;
  return {
    plan: parsed,
    usage: {
      inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
      outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    },
    truncated: Boolean(
      (json.choices as Array<{ finish_reason?: string }> | undefined)?.[0]
        ?.finish_reason === 'length',
    ),
    refused: false,
    model: config.ai.openai.model,
    provider: 'openai',
  };
}

function extractOpenAiText(json: Record<string, unknown>): string {
  const choices = json.choices as
    | Array<{ message?: { content?: string } }>
    | undefined;
  if (choices?.[0]?.message?.content) return choices[0].message.content;
  const output = json.output as Array<{ content?: Array<{ text?: string }> }> | undefined;
  if (output?.[0]?.content?.[0]?.text) return output[0].content[0].text;
  if (typeof json.output_text === 'string') return json.output_text;
  return '';
}

export async function generateWithClaude(
  input: LlmGenerateInput,
): Promise<LlmGenerateResult> {
  if (!config.ai.claude.apiKey) {
    throw Object.assign(new Error('provider_unconfigured'), {
      errorCode: 'provider_unconfigured',
    });
  }
  const prompt = buildPlanningPrompt(input);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.ai.claude.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ai.claude.model,
      max_tokens: config.ai.maxOutputTokens,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    }),
    signal: input.signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error('provider_unauthorized'), {
      errorCode: 'provider_refused',
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`provider_http_${response.status}`), {
      errorCode: response.status === 429 ? 'provider_refused' : 'provider_invalid_json',
    });
  }
  const json = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = json.content?.find((part) => part.type === 'text')?.text || '';
  if (!text) {
    throw Object.assign(new Error('empty_response'), {
      errorCode: json.stop_reason === 'refusal' ? 'provider_refused' : 'provider_invalid_json',
    });
  }
  let parsed: DraftPlanV1;
  try {
    parsed = JSON.parse(text) as DraftPlanV1;
  } catch {
    throw Object.assign(new Error('invalid_json'), {
      errorCode: 'provider_invalid_json',
    });
  }
  return {
    plan: parsed,
    usage: {
      inputTokens: Number(json.usage?.input_tokens || 0),
      outputTokens: Number(json.usage?.output_tokens || 0),
    },
    truncated: json.stop_reason === 'max_tokens',
    refused: json.stop_reason === 'refusal',
    model: config.ai.claude.model,
    provider: 'claude',
  };
}
