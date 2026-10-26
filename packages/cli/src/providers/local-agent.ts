import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProviderError } from './errors.js';
import type { ChatMessage, CompletionOptions, CompletionResult } from './complete.js';
import type { ProviderName } from '../types.js';
import { providerManager } from './manager.js';

export type LocalAgentName = 'opencode' | 'pi';

function isLocalAgent(name: ProviderName): name is LocalAgentName {
  return name === 'opencode' || name === 'pi';
}

export function localAgentName(name: ProviderName): LocalAgentName | null {
  return isLocalAgent(name) ? name : null;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function promptFrom(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const conversation = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const label = message.role === 'assistant' ? 'Assistant' : message.role === 'tool' ? 'Tool' : 'User';
      return `${label}:\n${message.content}`;
    })
    .join('\n\n');
  return { system, prompt: conversation };
}

const OPENCODE_MINIMAL_AGENT = {
  description: 'Minimal direct chat agent for MAD',
  mode: 'primary',
  prompt: 'You are MAD, a concise terminal coding assistant. Answer directly and keep responses short. Do not use tools.',
  permission: {
    edit: 'deny',
    bash: 'deny',
    read: 'deny',
    glob: 'deny',
    grep: 'deny',
    list: 'deny',
    task: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    lsp: 'deny',
    skill: 'deny',
    question: 'deny',
    todowrite: 'deny',
  },
};

let openCodeConfigPath: string | undefined;

function minimalOpenCodeConfig(): string {
  if (openCodeConfigPath && existsSync(openCodeConfigPath)) return openCodeConfigPath;

  const path = join(tmpdir(), `mad-opencode-${process.pid}.json`);
  let config: Record<string, unknown> = {};
  const existing = process.env.OPENCODE_CONFIG;
  if (existing && existsSync(existing)) {
    try {
      config = JSON.parse(readFileSync(existing, 'utf8')) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }

  const agents = (config.agent && typeof config.agent === 'object')
    ? config.agent as Record<string, unknown>
    : {};
  config.agent = { ...agents, 'mad-chat': OPENCODE_MINIMAL_AGENT };
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  openCodeConfigPath = path;
  return path;
}

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

function runProcess(
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
  onStdout: (chunk: string) => void,
  onStderr: (chunk: string) => void,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 60_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...extraEnv },
    });

    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };

    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_500);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });

    const timeout = setTimeout(() => {
      fail(new ProviderError(`${command} timed out after ${Math.round(timeoutMs / 1000)}s.`, command as ProviderName));
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_500);
      killTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => onStdout(chunk));
    child.stderr.on('data', (chunk: string) => onStderr(chunk));

    child.on('error', (error) => {
      fail(new ProviderError(`${command} failed to start: ${error.message}`, command as ProviderName));
    });

    child.on('close', (code, exitSignal) => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      finish();
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      resolve({ code, signal: exitSignal });
    });
  });
}

function selectedModel(name: LocalAgentName, options: CompletionOptions): string | undefined {
  const model = options.model ?? providerManager.getProvider(name)?.config.model;
  if (model && model !== 'default') return model;
  if (name === 'opencode') return 'opencode/deepseek-v4.1-flash-free';
  return undefined;
}

async function runOpenCode(
  messages: ChatMessage[],
  options: CompletionOptions,
  onDelta?: (delta: string) => void
): Promise<CompletionResult> {
  const { system, prompt } = promptFrom(messages);
  const model = selectedModel('opencode', options);
  let stdout = '';
  let stderr = '';
  let accumulated = '';
  let tokens = 0;
  let providerError = '';
  const localAbort = new AbortController();
  const forwardAbort = () => localAbort.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });

  const parse = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        part?: {
          type?: string;
          text?: string;
          tokens?: { total?: number };
        };
      };
      if (event.type === 'text' && event.part?.type === 'text' && event.part.text) {
        const text = event.part.text;
        if (text.startsWith(accumulated)) {
          const delta = text.slice(accumulated.length);
          if (delta) {
            accumulated += delta;
            onDelta?.(delta);
          }
        } else {
          accumulated += text;
          onDelta?.(text);
        }
      }
      if (event.type === 'step_finish' && event.part?.tokens?.total) {
        tokens = event.part.tokens.total;
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  };

  let buffer = '';
  const args = ['run', '--print-logs', '--log-level', 'ERROR', '--agent', 'mad-chat', '--format', 'json'];
  if (model) args.push('--model', model);
  args.push(system ? `${system}\n\n${prompt}` : prompt);

  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess(
      'opencode',
      args,
      localAbort.signal,
      (chunk) => {
        stdout += chunk;
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      },
      (chunk) => {
        stderr += chunk;
        if (!providerError && /AI_APICallError|stream error/i.test(chunk)) {
          providerError = chunk;
          localAbort.abort();
        }
      },
      { OPENCODE_CONFIG: minimalOpenCodeConfig() }
    );
  } catch (error) {
    if (providerError && (error as Error).name === 'AbortError') {
      const plain = stripAnsi(providerError);
      const detail = plain.match(/AI_APICallError:[^\n"]*/)?.[0] ?? plain.trim().slice(-600);
      throw new ProviderError(`opencode: ${detail}`, 'opencode');
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
  }

  if (buffer.trim()) parse(buffer);

  if (result.code !== 0) {
    throw new ProviderError(
      `opencode exited with code ${result.code}: ${stripAnsi(stderr).trim().slice(0, 600)}`,
      'opencode'
    );
  }

  if (!accumulated.trim()) {
    const fallback = stripAnsi(stdout).trim();
    if (fallback) {
      accumulated = fallback;
      onDelta?.(fallback);
    }
  }

  if (!accumulated.trim()) throw new ProviderError('opencode returned an empty response.', 'opencode');

  return {
    content: accumulated,
    tokens: tokens || Math.ceil(accumulated.length / 4),
    model: model ?? 'default',
    provider: 'opencode',
  };
}

async function runPi(
  messages: ChatMessage[],
  options: CompletionOptions,
  onDelta?: (delta: string) => void
): Promise<CompletionResult> {
  const { system, prompt } = promptFrom(messages);
  const model = selectedModel('pi', options);
  const args = [
    '-p',
    '--no-tools',
    '--no-session',
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--mode',
    'json',
  ];
  if (system) args.push('--system-prompt', system);
  if (model) args.push('--model', model);
  args.push(prompt);

  let output = '';
  let stderr = '';
  let buffer = '';
  let tokens = 0;

  const parse = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        usage?: { totalTokens?: number };
        message?: {
          role?: string;
          usage?: { totalTokens?: number };
          content?: Array<{ type?: string; text?: string }> | string;
        };
        assistantMessageEvent?: { type?: string; delta?: string };
      };
      const usage = event.usage ?? event.message?.usage;
      if (usage?.totalTokens) tokens = usage.totalTokens;

      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta ?? '';
        if (delta) {
          output += delta;
          onDelta?.(delta);
        }
      }

      if (event.type === 'message_end' && event.message?.role === 'assistant' && !output.trim()) {
        const content = event.message.content;
        const text = Array.isArray(content)
          ? content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
          : typeof content === 'string' ? content : '';
        if (text) {
          output = text;
          onDelta?.(text);
        }
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  };

  const result = await runProcess(
    'pi',
    args,
    options.signal,
    (chunk) => {
      buffer += stripAnsi(chunk);
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    },
    (chunk) => {
      stderr += chunk;
    }
  );

  if (buffer.trim()) parse(buffer);

  if (result.code !== 0) {
    throw new ProviderError(
      `pi exited with code ${result.code}: ${stripAnsi(stderr).trim().slice(0, 600)}`,
      'pi'
    );
  }

  const content = output.trim();
  if (!content) throw new ProviderError('pi returned an empty response.', 'pi');

  return {
    content,
    tokens: tokens || Math.ceil((content.length + system.length + prompt.length) / 4),
    model: model ?? 'default',
    provider: 'pi',
  };
}

export async function runLocalAgent(
  name: LocalAgentName,
  messages: ChatMessage[],
  options: CompletionOptions,
  onDelta?: (delta: string) => void
): Promise<CompletionResult> {
  if (name === 'opencode') return runOpenCode(messages, options, onDelta);
  return runPi(messages, options, onDelta);
}
