import type { ProviderName, ProviderResponse } from '../types.js';
import { providerManager } from './manager.js';
import { ProviderError } from './errors.js';
export { ProviderError } from './errors.js';
import { runLocalAgent, localAgentName } from './local-agent.js';

// ─── Strict Provider Completion ─────────────────────────────────────────────
// Agent loops cannot tolerate silent mock fallbacks: a harness must know when
// a model is unreachable. This layer throws instead of returning canned text,
// and it accepts full system/user/assistant message arrays for tool loops.
// ─────────────────────────────────────────────────────────────────────────────

export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: AssistantToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface NativeToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs: string;
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  model?: string;
  tools?: ToolDefinition[];
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface CompletionResult extends ProviderResponse {
  provider: ProviderName;
  toolCalls?: NativeToolCall[];
}


const DEFAULT_TIMEOUT_MS = 120_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function abortError(): Error {
  const err = new Error('Request aborted');
  err.name = 'AbortError';
  return err;
}

function joinSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  return { system, rest };
}

function withTimeout(signal: AbortSignal | undefined, ms = DEFAULT_TIMEOUT_MS): AbortSignal {
  if (signal) return signal;
  return AbortSignal.timeout(ms);
}

async function readError(provider: ProviderName, res: Response): Promise<never> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 800);
  } catch {
    body = res.statusText;
  }
  throw new ProviderError(`${provider} API ${res.status}: ${body || res.statusText}`, provider, res.status);
}

// ─── OpenAI-compatible (Groq / Codex) ───────────────────────────────────────

async function completeOpenAICompatible(
  provider: 'groq' | 'codex',
  messages: ChatMessage[],
  options: CompletionOptions
): Promise<CompletionResult> {
  const key = provider === 'groq'
    ? process.env.GROQ_API_KEY || providerManager.getApiKey('groq')
    : process.env.OPENAI_API_KEY || providerManager.getApiKey('codex');

  if (!key) {
    throw new ProviderError(`${provider} is not authenticated. Run: mad auth ${provider}`, provider, 401);
  }

  const baseUrl = provider === 'groq'
    ? 'https://api.groq.com/openai/v1'
    : (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');

  const configuredModel = providerManager.getProvider(provider)?.config.model;
  const models = provider === 'groq'
    ? [...new Set([
        options.model,
        configuredModel,
        process.env.GROQ_MODEL,
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
      ].filter(Boolean) as string[])]
    : [options.model || configuredModel || process.env.OPENAI_MODEL || 'gpt-4o'];

  let lastError: Error | null = null;
  const modelErrors: string[] = [];

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: options.maxTokens ?? 4096,
            temperature: options.temperature ?? 0.2,
            ...(provider === 'groq' && model.includes('gpt-oss')
              ? { reasoning_effort: options.reasoningEffort ?? 'low' }
              : {}),
            ...(options.tools?.length
              ? {
                  tools: options.tools.map((tool) => ({
                    type: 'function',
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    },
                  })),
                  tool_choice: 'auto',
                  parallel_tool_calls: false,
                }
              : {}),
          }),
          signal: withTimeout(options.signal),
        });

        if (!res.ok) {
          if (provider === 'groq' && (res.status === 404 || res.status === 400)) {
            let body = '';
            try { body = (await res.text()).slice(0, 400); } catch { body = res.statusText; }
            lastError = new ProviderError(`Groq model ${model} unavailable (${res.status}): ${body}`, provider, res.status);
            modelErrors.push(lastError.message);
            break;
          }
          if (provider === 'groq' && res.status === 429) {
            const retryAfter = Number(res.headers.get('retry-after'));
            const wait = Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(20_000, retryAfter * 1_000)
              : 4_000 * (attempt + 1);
            let body = '';
            try { body = (await res.text()).slice(0, 240); } catch { body = res.statusText; }
            lastError = new ProviderError(`Groq rate limit on ${model} (429); waited ${wait}ms: ${body}`, provider, 429);
            if (attempt < 2) {
              await sleep(wait, options.signal);
              continue;
            }
            modelErrors.push(lastError.message);
            break;
          }
          if (provider === 'groq' && res.status === 413) {
            lastError = new ProviderError(`Groq context limit on ${model} (413)`, provider, 413);
            modelErrors.push(lastError.message);
            break;
          }
          await readError(provider, res);
        }

        const data = (await res.json()) as {
          choices?: Array<{
            message?: {
              content?: string | null;
              tool_calls?: Array<{
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string | Record<string, unknown> };
              }>;
            };
          }>;
          usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
          model?: string;
        };

        const message = data.choices?.[0]?.message;
        const content = message?.content ?? '';
        const toolCalls: NativeToolCall[] = (message?.tool_calls ?? []).map((call, index) => {
          const rawArgs = typeof call.function?.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {});
          let args: Record<string, unknown> = {};
          if (typeof call.function?.arguments === 'object' && call.function.arguments) {
            args = call.function.arguments as Record<string, unknown>;
          } else {
            try {
              const parsed = JSON.parse(rawArgs);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                args = parsed as Record<string, unknown>;
              }
            } catch {
              args = {};
            }
          }
          return {
            id: call.id || `call_${index}`,
            name: call.function?.name || 'unknown',
            args,
            rawArgs,
          };
        });
        const usageTotal = data.usage?.total_tokens
          ?? ((data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0));
        const tokens = usageTotal || Math.ceil(content.length / 4);

        return { content, tokens, model: data.model || model, provider, toolCalls: toolCalls.length ? toolCalls : undefined };
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError instanceof ProviderError && lastError.status === 401) throw lastError;
        modelErrors.push(lastError.message);
        break;
      }
    }
  }

  throw new ProviderError(
    modelErrors.length ? modelErrors.join('\n') : `${provider} completion failed`,
    provider
  );
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

async function completeClaude(
  messages: ChatMessage[],
  options: CompletionOptions
): Promise<CompletionResult> {
  const key = process.env.ANTHROPIC_API_KEY || providerManager.getApiKey('claude');
  if (!key) throw new ProviderError('claude is not authenticated. Run: mad auth claude', 'claude', 401);

  const { system, rest } = joinSystem(messages);
  const anthropicMessages = rest.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model || providerManager.getProvider('claude')?.config.model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
      system: system || undefined,
      messages: anthropicMessages,
    }),
    signal: withTimeout(options.signal),
  });

  if (!res.ok) await readError('claude', res);

  const data = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    model?: string;
  };

  const content = (data.content ?? [])
    .filter((part) => part.type === 'text' || part.text)
    .map((part) => part.text ?? '')
    .join('');
  const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

  return {
    content,
    tokens: tokens || Math.ceil(content.length / 4),
    model: data.model || 'claude-3-5-sonnet',
    provider: 'claude',
  };
}

// ─── Gemini ─────────────────────────────────────────────────────────────────

async function completeGemini(
  messages: ChatMessage[],
  options: CompletionOptions
): Promise<CompletionResult> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || providerManager.getApiKey('gemini');
  if (!key) throw new ProviderError('gemini is not authenticated. Run: mad auth gemini', 'gemini', 401);

  const { system, rest } = joinSystem(messages);
  const model = options.model || providerManager.getProvider('gemini')?.config.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: rest.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          maxOutputTokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.2,
        },
      }),
      signal: withTimeout(options.signal),
    }
  );

  if (!res.ok) await readError('gemini', res);

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { totalTokenCount?: number };
  };

  const content = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('');
  const tokens = data.usageMetadata?.totalTokenCount ?? Math.ceil(content.length / 4);

  return { content, tokens, model, provider: 'gemini' };
}

// ─── Ollama ─────────────────────────────────────────────────────────────────

async function completeOllama(
  messages: ChatMessage[],
  options: CompletionOptions
): Promise<CompletionResult> {
  const baseUrl = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const model = options.model || providerManager.getProvider('ollama')?.config.model || process.env.OLLAMA_MODEL || 'llama3';

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature: options.temperature ?? 0.2 },
    }),
    signal: withTimeout(options.signal),
  });

  if (!res.ok) await readError('ollama', res);

  const data = (await res.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const content = data.message?.content ?? '';
  const tokens = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);

  return { content, tokens: tokens || Math.ceil(content.length / 4), model, provider: 'ollama' };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function complete(
  provider: ProviderName,
  messages: ChatMessage[],
  options: CompletionOptions = {}
): Promise<CompletionResult> {
  switch (provider) {
    case 'groq':
    case 'codex':
      return completeOpenAICompatible(provider, messages, options);
    case 'claude':
      return completeClaude(messages, options);
    case 'gemini':
      return completeGemini(messages, options);
    case 'ollama':
      return completeOllama(messages, options);
    default: {
      const local = localAgentName(provider);
      if (local) return runLocalAgent(local, messages, options);
      throw new ProviderError(`Unknown provider: ${provider as string}`, provider);
    }
  }
}

/**
 * Try the preferred provider first, then walk MAD Fabric's fallback chain.
 * Agent loops use this so a rate-limited model does not kill a long task.
 */
export async function completeWithFallback(
  preferred: ProviderName,
  messages: ChatMessage[],
  options: CompletionOptions = {}
): Promise<CompletionResult> {
  const chain: ProviderName[] = [preferred, ...providerManager.getFallbackChain(preferred)];
  const errors: string[] = [];

  for (const provider of chain) {
    try {
      return await complete(provider, messages, options);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All providers failed.\n${errors.join('\n')}`);
}

/** True when at least one provider can serve a real completion. */
export function hasLiveProvider(): boolean {
  return providerManager.getFirstConnectedProvider() !== null
    || Boolean(process.env.OLLAMA_HOST);
}
