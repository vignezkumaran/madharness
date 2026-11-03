// ─── Local CLI agent providers (opencode, pi) ───────────────────────────────
// Spawns the CLI with a minimal/no-tools config and parses its JSON event
// stream. Model rotation on quota errors, SIGKILL escalation, last-good model.
import { OpenCodeEvents } from './opencode-events.js';
import { spawn, execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { estimateTokens } from '../tokens/estimator.js';
import type { LlmRequest, LlmResult, ProviderClient, ProviderMessage, } from './types.js';
import type { StreamFn } from './client.js';
export type LocalAgentName = 'opencode' | 'pi';
export function localAgentName(name: string): LocalAgentName | null {
    return name === 'opencode' || name === 'pi' ? name : null;
}
export function isLocalAgentInstalled(name: LocalAgentName): boolean {
    try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}
interface ProcessOutcome {
    code: number | null;
    signal: string | null;
}
function runProcess(command: string, args: string[], signal: AbortSignal | undefined, onStdout: (chunk: string) => void, onStderr: (chunk: string) => void, extraEnv: NodeJS.ProcessEnv, timeoutMs = 120000): Promise<ProcessOutcome> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const child = spawn(command, args, {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...extraEnv },
        });
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const cleanup = () => {
            signal?.removeEventListener('abort', abort);
        };
        const killTree = () => {
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
            killTimer.unref();
        };
        const fail = (error: Error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        };
        const abort = () => killTree();
        signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(() => {
            fail(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
            killTree();
        }, timeoutMs);
        timeout.unref();
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => onStdout(chunk));
        child.stderr.on('data', (chunk: string) => onStderr(chunk));
        child.on('error', (error) => fail(error));
        child.on('close', (code, closeSignal) => {
            clearTimeout(timeout);
            if (killTimer)
                clearTimeout(killTimer);
            cleanup();
            if (settled)
                return;
            settled = true;
            if (signal?.aborted) {
                reject(new Error('aborted'));
                return;
            }
            resolve({ code, signal: closeSignal ?? null });
        });
    });
}
function conversationInput(req: LlmRequest): string {
    return [req.system, req.tools?.length ? `Tool schemas (encode calls as JSON actions): ${JSON.stringify(req.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))}` : '', ...req.messages.map(m => `${m.role}${m.name ? ` ${m.name}` : ''}: ${m.content}${m.toolCalls?.length ? `\nTool calls: ${JSON.stringify(m.toolCalls)}` : ''}`)]
        .filter(Boolean)
        .join('\n\n');
}
// ─── opencode ───────────────────────────────────────────────────────────────
const OPENCODE_MINIMAL_AGENT = {
    description: 'Minimal direct chat agent for MAD',
    mode: 'primary',
    prompt: 'You are MAD, a terminal coding assistant. Follow the response format requested in the user message exactly. Keep answers short. Do not call built-in tools; encode any requested tool use as text only.',
    tools: { '*': false, bash: false, read: false, glob: false, grep: false, list: false, edit: false, write: false, task: false, webfetch: false, todowrite: false, question: false, skill: false },
    permission: { '*': 'deny' },
};
let openCodeConfigPath: string | undefined;
function minimalOpenCodeConfig(): string {
    if (openCodeConfigPath && existsSync(openCodeConfigPath))
        return openCodeConfigPath;
    const file = join(tmpdir(), `mad-opencode-${process.pid}.json`);
    let config: Record<string, unknown> = {};
    const existing = process.env.OPENCODE_CONFIG;
    if (existing && existsSync(existing)) {
        try {
            config = JSON.parse(readFileSync(existing, 'utf8')) as Record<string, unknown>;
        }
        catch {
            config = {};
        }
    }
    const agents = (config.agent && typeof config.agent === 'object') ? config.agent as Record<string, unknown> : {};
    config.agent = { ...agents, 'mad-chat': OPENCODE_MINIMAL_AGENT };
    writeFileSync(file, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    openCodeConfigPath = file;
    return file;
}
// Free opencode models have separate quotas; the CLI still exits 0 with an
// empty result when one is exhausted, so rotate through known-good models.
const OPENCODE_FALLBACK_MODELS = [
    'opencode/glm-5.3-flash-free',
    'opencode/beam-free',
    'opencode/big-pickle',
    'opencode/flint-40b-free',
    'opencode/mimo-v2.6-flash-free',
    'opencode/nemotron-3.5-lightning-free',
];
let lastGoodOpenCodeModel: string | undefined;
function openCodeErrorDetail(stderr: string, code: number | null): string {
    const plain = stripAnsi(stderr).replace(/\\n/g, '\n');
    const apiError = plain.match(/AI_APICallError:\s*([^\n"]+)/)?.[1]?.trim();
    const line = apiError
        ?? plain.split('\n').map((entry) => entry.trim()).filter(Boolean).slice(-1)[0]
        ?? '';
    if (line)
        return line.length > 400 ? `${line.slice(0, 400)}…` : line;
    return code === 0 ? 'model returned no output' : `opencode exited with code ${code}`;
}
function isOpenCodeLimitError(chunk: string): boolean {
    if (/free usage limit reached/i.test(chunk))
        return true;
    return /AI_APICallError/.test(chunk)
        && /(rate.?limit|quota|too many requests|usage limit|\b429\b)/i.test(chunk);
}
export function opencodeClient(configuredModel: () => string, exactModel = false): ProviderClient {
    const events = new OpenCodeEvents(minimalOpenCodeConfig);
    let actualModel = configuredModel();
    async function chat(req: LlmRequest, stream: boolean, onDelta: StreamFn): Promise<LlmResult> {
        const override = process.env.MAD_OPENCODE_MODEL?.trim();
        const configured = configuredModel() !== 'default' ? configuredModel() : undefined;
        const candidates = [...new Set((exactModel ? [configured] : [override, configured, lastGoodOpenCodeModel, ...OPENCODE_FALLBACK_MODELS.slice(0, 2)])
                .filter((model): model is string => Boolean(model)))];
        const input = conversationInput(req);
        const failures: string[] = [];
        for (const model of candidates) {
            if (req.signal?.aborted)
                throw new Error('aborted');
            const attempt = await attemptOpenCode(model, input, req.signal, stream, stream ? onDelta : undefined);
            const content = attempt.content.trim();
            if (content) {
                lastGoodOpenCodeModel = model;
                actualModel = model;
                return {
                    text: content,
                    toolCalls: [],
                    usage: attempt.usage ?? { input: estimateTokens(input), output: estimateTokens(content), estimated: true },
                };
            }
            failures.push(`${model}: ${openCodeErrorDetail(attempt.stderr, attempt.code)}`);
            const retryable = attempt.code !== 0 || !attempt.stderr
                || /free usage limit|rate limit|quota|too many requests|429|overloaded|not found|unavailable|no such model|AI_APICallError|stream error|timed out/i.test(stripAnsi(attempt.stderr));
            if (!retryable)
                break;
        }
        throw Object.assign(new Error(`opencode could not produce a reply.\n${failures.slice(0, 3).join('\n')}`), { status: 502 });
    }
    return {
        name: 'opencode',
        toolProtocol: 'text',
        close: () => events.close(),
        streaming: true,
        hasKey: () => isLocalAgentInstalled('opencode'),
        defaultModel: () => actualModel || configuredModel() || lastGoodOpenCodeModel || OPENCODE_FALLBACK_MODELS[0],
        models: OPENCODE_FALLBACK_MODELS.slice(0, 4),
        complete: (req) => chat(req, false, () => { }),
        stream: async (req, onDelta) => {
            if (process.env.MAD_OPENCODE_TRANSPORT === 'run')
                return chat(req, true, onDelta);
            const candidates = [...new Set((exactModel ? [configuredModel()] : [process.env.MAD_OPENCODE_MODEL, configuredModel(), lastGoodOpenCodeModel, ...OPENCODE_FALLBACK_MODELS.slice(0, 2)]).filter((model): model is string => Boolean(model) && model !== 'default'))];
            let failure: unknown;
            for (const model of candidates) {
                let emitted = false;
                try {
                    const result = await events.stream(req, model, text => { emitted = true; onDelta(text, null); });
                    lastGoodOpenCodeModel = model;
                    actualModel = model;
                    return result;
                }
                catch (error) {
                    failure = error;
                    if (emitted || req.signal?.aborted || !/quota|rate.?limit|usage.?limit|429|not.?found|unavailable|ModelNotFound/i.test((error as Error).message))
                        throw error;
                }
            }
            throw failure ?? new Error('No OpenCode model configured');
        },
    };
}
interface OpenCodeAttempt {
    content: string;
    tokens: number;
    usage?: import('./types.js').LlmUsage;
    stderr: string;
    code: number | null;
}
async function attemptOpenCode(model: string, input: string, signal: AbortSignal | undefined, stream: boolean, onDelta?: StreamFn): Promise<OpenCodeAttempt> {
    let stdout = '';
    let stderr = '';
    let accumulated = '';
    let tokens = 0;
    let sawJson = false;
    let usage: import('./types.js').LlmUsage | undefined;
    const parse = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{'))
            return;
        sawJson = true;
        try {
            const event = JSON.parse(trimmed) as {
                type?: string;
                part?: {
                    type?: string;
                    text?: string;
                    tokens?: {
                        total?: number;
                        input?: number;
                        output?: number;
                    };
                };
            };
            if (event.type === 'text' && event.part?.type === 'text' && event.part.text) {
                const text = event.part.text;
                const delta = text.startsWith(accumulated) ? text.slice(accumulated.length) : text;
                if (delta) {
                    accumulated += delta;
                    if (stream)
                        onDelta?.(delta, null);
                }
            }
            if (event.type === 'step_finish' && typeof event.part?.tokens?.input === 'number' && typeof event.part.tokens.output === 'number') {
                usage ??= { input: 0, output: 0 };
                usage.input += event.part.tokens.input;
                usage.output += event.part.tokens.output;
            }
            if (event.type === 'step_finish' && event.part?.tokens?.total)
                tokens = event.part.tokens.total;
        }
        catch {
            // ignore non-JSON log lines
        }
    };
    let buffer = '';
    const args = ['run', '--print-logs', '--log-level', 'ERROR', '--agent', 'mad-chat', '--format', 'json', '--model', model, input];
    // opencode keeps retrying a rate-limited model and never exits; kill the
    // attempt as soon as a quota error arrives and let the caller rotate models.
    const localAbort = new AbortController();
    const forwardAbort = () => localAbort.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    let abortedForFallback = false;
    let result: ProcessOutcome | null = null;
    try {
        result = await runProcess('opencode', args, localAbort.signal, (chunk) => {
            stdout += chunk;
            buffer += chunk;
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                parse(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
            }
        }, (chunk) => {
            stderr += chunk;
            if (!accumulated && !abortedForFallback && isOpenCodeLimitError(chunk)) {
                abortedForFallback = true;
                localAbort.abort();
            }
        }, { OPENCODE_CONFIG: minimalOpenCodeConfig() });
    }
    catch (error) {
        if (signal?.aborted && !abortedForFallback)
            throw error;
        result = { code: null, signal: null };
    }
    finally {
        signal?.removeEventListener('abort', forwardAbort);
    }
    if (buffer.trim())
        parse(buffer);
    if (!accumulated.trim() && !sawJson) {
        const plain = stripAnsi(stdout).trim();
        if (plain) {
            accumulated = plain;
            if (stream)
                onDelta?.(plain, null);
        }
    }
    return { content: accumulated, tokens, usage, stderr, code: result.code };
}
// ─── pi ─────────────────────────────────────────────────────────────────────
export function piClient(configuredModel: () => string, systemPromptMode: 'join' | 'separate' = 'separate'): ProviderClient {
    async function runPi(req: LlmRequest, stream: boolean, onDelta: StreamFn): Promise<LlmResult> {
        const model = configuredModel();
        const args = ['-p', '--no-tools', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--mode', 'json'];
        const system = req.messages.some((m) => m.role === 'system')
            ? [...req.messages.filter((m) => m.role === 'system').map((m) => m.content)].join('\n\n')
            : '';
        const joinedSystem = [req.system, system, req.tools?.length ? `Tool schemas: ${JSON.stringify(req.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))}` : ''].filter(Boolean).join('\n\n');
        if (joinedSystem && systemPromptMode === 'separate')
            args.push('--system-prompt', joinedSystem);
        if (model && model !== 'default')
            args.push('--model', model);
        const userTurnText = req.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
        args.push(joinedSystem && systemPromptMode === 'join' ? `${joinedSystem}\n\n${userTurnText}` : userTurnText);
        let output = '';
        let stderr = '';
        let buffer = '';
        let tokens = 0;
        const parse = (line: string): void => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{'))
                return;
            try {
                const event = JSON.parse(trimmed) as {
                    type?: string;
                    usage?: {
                        totalTokens?: number;
                    };
                    message?: {
                        role?: string;
                        usage?: {
                            totalTokens?: number;
                        };
                        content?: Array<{
                            type?: string;
                            text?: string;
                        }> | string;
                    };
                    assistantMessageEvent?: {
                        type?: string;
                        delta?: string;
                    };
                };
                const usage = event.usage ?? event.message?.usage;
                if (usage?.totalTokens)
                    tokens = usage.totalTokens;
                if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
                    const delta = event.assistantMessageEvent.delta ?? '';
                    if (delta) {
                        output += delta;
                        if (stream)
                            onDelta(delta, null);
                    }
                }
                if (event.type === 'message_end' && event.message?.role === 'assistant' && !output.trim()) {
                    const content = event.message.content;
                    output = Array.isArray(content)
                        ? content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
                        : typeof content === 'string' ? content : '';
                    if (output && stream)
                        onDelta(output, null);
                }
            }
            catch {
                // ignore non-JSON log lines
            }
        };
        const result = await runProcess('pi', args, req.signal, (chunk) => {
            buffer += stripAnsi(chunk);
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                parse(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
            }
        }, (chunk) => {
            stderr += chunk;
        }, {});
        if (buffer.trim())
            parse(buffer);
        if (result.code !== 0) {
            throw Object.assign(new Error(`pi exited with code ${result.code}: ${stripAnsi(stderr).trim().slice(0, 600)}`), { status: 502 });
        }
        const content = output.trim();
        if (!content)
            throw Object.assign(new Error('pi returned an empty response'), { status: 502 });
        return {
            text: content,
            toolCalls: [],
            usage: { input: estimateTokens(joinedSystem + userTurnText), output: estimateTokens(content), estimated: true },
        };
    }
    return {
        name: 'pi',
        toolProtocol: 'text',
        streaming: true,
        hasKey: () => isLocalAgentInstalled('pi'),
        defaultModel: () => configuredModel() || 'default',
        models: [],
        complete: (req) => runPi(req, false, () => { }),
        stream: (req, onDelta) => runPi(req, true, onDelta),
    };
}
export type { ProviderMessage };
