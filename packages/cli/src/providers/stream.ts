import type { ProviderName } from '../types.js';
import { providerManager } from './manager.js';
import { runLocalAgent, localAgentName } from './local-agent.js';
import {
  complete,
  ProviderError,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
} from './complete.js';

export type StreamHandler = (delta: string) => void;

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function readError(provider: ProviderName, response: Response): Promise<never> {
  let body = '';
  try {
    body = (await response.text()).slice(0, 800);
  } catch {
    body = response.statusText;
  }
  throw new ProviderError(`${provider} API ${response.status}: ${body || response.statusText}`, provider, response.status);
}

async function* eventLines(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new ProviderError('Streaming response has no body', 'groq');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
        newline = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

async function* dataEvents(response: Response): AsyncGenerator<string> {
  for await (const line of eventLines(response)) {
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (data) yield data;
    }
  }
}

async function streamOpenAICompatible(
  provider: 'groq' | 'codex',
  messages: ChatMessage[],
  options: CompletionOptions,
  onDelta: StreamHandler,
  received: { value: boolean }
): Promise<CompletionResult> {
  const key = provider === 'groq'
    ? process.env.GROQ_API_KEY || providerManager.getApiKey('groq')
    : process.env.OPENAI_API_KEY || providerManager.getApiKey('codex');
  if (!key) throw new ProviderError(`${provider} is not authenticated. Run: mad auth ${provider}`, provider, 401);

  const baseUrl = provider === 'groq'
    ? 'https://api.groq.com/openai/v1'
    : (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
  const configured = providerManager.getProvider(provider)?.config.model;
  const model = options.model
    || configured
    || (provider === 'groq' ? 'openai/gpt-oss-120b' : 'gpt-4o');

  assertNotAborted(options.signal);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
      ...(provider === 'groq' && model.includes('gpt-oss')
        ? { reasoning_effort: options.reasoningEffort ?? 'low' }
        : {}),
    }),
    signal: options.signal ?? AbortSignal.timeout(120_000),
  });

  if (!response.ok) await readError(provider, response);

  let content = '';
  let tokens = 0;
  let responseModel = model;

  for await (const data of dataEvents(response)) {
    if (data === '[DONE]') break;
    let parsed: {
      choices?: Array<{ delta?: { content?: string | null } }>;
      usage?: { total_tokens?: number };
      model?: string;
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = parsed.choices?.[0]?.delta?.content ?? '';
    if (delta) {
      content += delta;
      received.value = true;
      onDelta(delta);
    }
    if (parsed.usage?.total_tokens) tokens = parsed.usage.total_tokens;
    if (parsed.model) responseModel = parsed.model;
  }

  return {
    content,
    tokens: tokens || Math.ceil(content.length / 4),
    model: responseModel,
    provider,
  };
}

async function streamOllama(
  messages: ChatMessage[],
  options: CompletionOptions,
  onDelta: StreamHandler,
  received: { value: boolean }
): Promise<CompletionResult> {
  const baseUrl = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const model = options.model || providerManager.getProvider('ollama')?.config.model || process.env.OLLAMA_MODEL || 'llama3';

  assertNotAborted(options.signal);
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: { temperature: options.temperature ?? 0.2 },
    }),
    signal: options.signal ?? AbortSignal.timeout(120_000),
  });

  if (!response.ok) await readError('ollama', response);

  let content = '';
  let promptTokens = 0;
  let evalTokens = 0;

  for await (const line of eventLines(response)) {
    let parsed: {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const delta = parsed.message?.content ?? '';
    if (delta) {
      content += delta;
      received.value = true;
      onDelta(delta);
    }
    if (parsed.prompt_eval_count) promptTokens = parsed.prompt_eval_count;
    if (parsed.eval_count) evalTokens = parsed.eval_count;
  }

  const tokens = promptTokens + evalTokens;
  return {
    content,
    tokens: tokens || Math.ceil(content.length / 4),
    model,
    provider: 'ollama',
  };
}

async function streamClaude(
  messages: ChatMessage[],
  options: CompletionOptions,
  onDelta: StreamHandler,
  received: { value: boolean }
): Promise<CompletionResult> {
  const key = process.env.ANTHROPIC_API_KEY || providerManager.getApiKey('claude');
  if (!key) throw new ProviderError('claude is not authenticated. Run: mad auth claude', 'claude', 401);

  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const rest = messages.filter((message) => message.role !== 'system');
  const model = options.model || providerManager.getProvider('claude')?.config.model || 'claude-3-5-sonnet-20241022';

  assertNotAborted(options.signal);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      system,
      messages: rest.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      })),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
      stream: true,
    }),
    signal: options.signal ?? AbortSignal.timeout(120_000),
  });

  if (!response.ok) await readError('claude', response);

  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of dataEvents(response)) {
    let parsed: {
      type?: string;
      delta?: { type?: string; text?: string };
      message?: { usage?: { input_tokens?: number } };
      usage?: { output_tokens?: number };
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta.text) {
      content += parsed.delta.text;
      received.value = true;
      onDelta(parsed.delta.text);
    }
    if (parsed.type === 'message_start') inputTokens = parsed.message?.usage?.input_tokens ?? 0;
    if (parsed.type === 'message_delta') outputTokens = parsed.usage?.output_tokens ?? outputTokens;
  }

  const tokens = inputTokens + outputTokens;
  return {
    content,
    tokens: tokens || Math.ceil(content.length / 4),
    model,
    provider: 'claude',
  };
}

async function streamGemini(
  messages: ChatMessage[],
  options: CompletionOptions,
  onDelta: StreamHandler,
  received: { value: boolean }
): Promise<CompletionResult> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || providerManager.getApiKey('gemini');
  if (!key) throw new ProviderError('gemini is not authenticated. Run: mad auth gemini', 'gemini', 401);

  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const rest = messages.filter((message) => message.role !== 'system');
  const model = options.model || providerManager.getProvider('gemini')?.config.model || 'gemini-2.0-flash';

  assertNotAborted(options.signal);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: rest.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        generationConfig: {
          maxOutputTokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.2,
        },
      }),
      signal: options.signal ?? AbortSignal.timeout(120_000),
    }
  );

  if (!response.ok) await readError('gemini', response);

  let content = '';
  let tokens = 0;

  for await (const data of dataEvents(response)) {
    let parsed: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { totalTokenCount?: number };
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = (parsed.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
    if (delta) {
      content += delta;
      received.value = true;
      onDelta(delta);
    }
    if (parsed.usageMetadata?.totalTokenCount) tokens = parsed.usageMetadata.totalTokenCount;
  }

  return {
    content,
    tokens: tokens || Math.ceil(content.length / 4),
    model,
    provider: 'gemini',
  };
}

export async function streamChat(
  provider: ProviderName,
  messages: ChatMessage[],
  options: CompletionOptions,
  onDelta: StreamHandler
): Promise<CompletionResult> {
  const received = { value: false };
  try {
    switch (provider) {
      case 'groq':
      case 'codex':
        return await streamOpenAICompatible(provider, messages, options, onDelta, received);
      case 'claude':
        return await streamClaude(messages, options, onDelta, received);
      case 'gemini':
        return await streamGemini(messages, options, onDelta, received);
      case 'ollama':
        return await streamOllama(messages, options, onDelta, received);
      default: {
        const local = localAgentName(provider);
        if (local) {
          const result = await runLocalAgent(local, messages, options, (delta) => {
            received.value = true;
            onDelta(delta);
          });
          return result;
        }
        throw new ProviderError(`Unknown provider: ${provider as string}`, provider);
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    if (received.value) throw error;
    const result = await complete(provider, messages, options);
    if (result.content) onDelta(result.content);
    return result;
  }
}
