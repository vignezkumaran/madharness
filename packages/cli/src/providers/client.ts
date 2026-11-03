// ─── Remote provider clients: OpenAI-compatible, Anthropic, Gemini ──────────
// One implementation per wire API instead of per provider. Streaming with
// strict finish aggregation; tool-call deltas aggregated; retry on 429/5xx.
import { httpFailure, preparePost, runWithRetry, sseData, } from './http.js';
import type { LlmRequest, LlmResult, ProviderClient, ToolCallRequest, } from './types.js';
import { toolSpecToOpenAi } from './types.js';
export type StreamFn = (text: string | null, record: unknown) => void;
interface ChatOutcome {
    text: string;
    calls: ToolCallRequest[];
    usage: LlmResult['usage'] | undefined;
}
function extractUsage(usage: unknown | undefined | null): LlmResult['usage'] | undefined {
    if (!usage || typeof usage !== 'object')
        return undefined;
    const record = usage as {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
    };
    const input = Number(record.prompt_tokens ?? record.input_tokens ?? 0);
    const output = Number(record.completion_tokens ?? record.output_tokens ?? 0);
    if (!input && !output)
        return undefined;
    return { input, output };
}
class ToolCallAggregator {
    private readonly calls = new Map<number, ToolCallRequest>();
    see(index: number, id: string, name: string, argFragment: string): void {
        const existing = this.calls.get(index);
        if (existing) {
            if (id)
                existing.id = id;
            if (name)
                existing.name += name;
            existing.args += argFragment;
            return;
        }
        this.calls.set(index, { id: id || `call_${index}`, name, args: argFragment });
    }
    finish(): ToolCallRequest[] {
        return Array.from(this.calls.values()).map((call) => ({
            ...call,
            args: call.args.trim() ? call.args : '{}',
        }));
    }
}
function buildClient(name: string, chat: (req: LlmRequest, model: string, stream: boolean, onDelta: StreamFn) => Promise<ChatOutcome>, meta: {
    models: string[];
    defaultModel: () => string;
    hasKey: () => boolean;
}): ProviderClient {
    return {
        name,
        models: meta.models,
        streaming: true,
        defaultModel: meta.defaultModel,
        hasKey: meta.hasKey,
        async complete(req: LlmRequest): Promise<LlmResult> {
            const outcome = await runWithRetry({
                label: name,
                signal: req.signal,
                run: () => chat(req, meta.defaultModel(), false, () => { }),
            });
            return { text: outcome.text, toolCalls: outcome.calls, usage: outcome.usage };
        },
        async stream(req: LlmRequest, onDelta: StreamFn): Promise<LlmResult> {
            let firstAttempt = true;
            const outcome = await runWithRetry({
                label: name,
                signal: req.signal,
                run: async () => {
                    const streamed = firstAttempt;
                    firstAttempt = false;
                    return chat(req, meta.defaultModel(), streamed, (text) => {
                        if (streamed)
                            onDelta(text, null);
                    });
                },
            });
            onDelta(null, 'done');
            return { text: outcome.text, toolCalls: outcome.calls, usage: outcome.usage };
        },
    };
}
// ─── OpenAI-compatible chat completions (groq, openai, ollama /v1, ...) ─────
export function openAiCompatClient(args: {
    name: string;
    baseUrl: () => string;
    key: () => string | undefined;
    models: string[];
    defaultModel: () => string;
    streamCapable?: boolean;
}): ProviderClient {
    const { name, baseUrl, key, models, defaultModel } = args;
    const chat = async (req: LlmRequest, model: string, stream: boolean, onDelta: StreamFn): Promise<ChatOutcome> => {
        const payload = {
            model,
            messages: [{ role: 'system', content: req.system }, ...req.messages.filter(m => m.role !== 'system').map(m => m.role === 'tool' ? { role: 'tool', tool_call_id: m.callId, content: m.content } : { role: m.role, content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } })) } : {}) })],
            max_tokens: req.maxTokens ?? 2600,
            temperature: req.temperature ?? 0.1,
            stream,
            ...(stream ? { stream_options: { include_usage: true } } : {}),
            ...(req.tools?.length
                ? {
                    tools: toolSpecToOpenAi(req.tools),
                    tool_choice: 'auto',
                }
                : {}),
        };
        const headers: Record<string, string> = {};
        const k = key();
        if (k)
            headers.authorization = `Bearer ${k}`;
        const prepared = preparePost(req, {
            url: `${baseUrl().replace(/\/$/, '')}/chat/completions`,
            payload,
            headers,
            timeoutMs: stream ? 0 : 180000,
        });
        const response = await fetch(prepared.url, {
            method: 'POST',
            headers: prepared.headers,
            body: prepared.body,
            signal: prepared.signal,
        });
        if (!response.ok)
            throw await httpFailure(name, response);
        let text = '';
        const aggregator = new ToolCallAggregator();
        let usage: LlmResult['usage'];
        if (stream && response.body) {
            for await (const payload of sseData(response)) {
                if (payload === '[DONE]')
                    break;
                let chunk: unknown;
                try {
                    chunk = JSON.parse(payload);
                }
                catch {
                    continue;
                }
                const record = chunk as {
                    choices?: Array<{
                        delta?: {
                            content?: string | null;
                            tool_calls?: Array<Record<string, unknown>>;
                        };
                    }>;
                    usage?: unknown;
                };
                const delta = record.choices?.[0]?.delta;
                if (typeof delta?.content === 'string' && delta.content) {
                    text += delta.content;
                    onDelta(delta.content, null);
                }
                for (const fragment of delta?.tool_calls ?? []) {
                    const index = Number(fragment.index ?? 0);
                    const fn = fragment.function as Partial<{
                        name: unknown;
                        arguments: string;
                    }> | undefined;
                    if (!fn)
                        continue;
                    aggregator.see(index, String(fragment.id ?? ''), String(fn.name ?? ''), typeof fn.arguments === 'string' ? fn.arguments : '');
                }
                usage = extractUsage(record.usage) ?? usage;
            }
        }
        else {
            const json = (await response.json()) as {
                choices?: Array<{
                    message?: {
                        content?: string | null;
                        tool_calls?: Array<{
                            id?: string;
                            function?: {
                                name?: string;
                                arguments?: string;
                            };
                        }>;
                    };
                }>;
                usage?: unknown;
            };
            text = json.choices?.[0]?.message?.content ?? '';
            for (const [index, call] of (json.choices?.[0]?.message?.tool_calls ?? []).entries()) {
                if (!call.function?.name)
                    continue;
                aggregator.see(index, call.id ?? '', call.function.name, call.function.arguments ?? '');
            }
            usage = extractUsage(json.usage);
        }
        return { text, calls: aggregator.finish(), usage };
    };
    return buildClient(name, chat, {
        models,
        defaultModel,
        hasKey: () => (key() ?? '').length > 0,
    });
}
// ─── Anthropic ──────────────────────────────────────────────────────────────
export function anthropicClient(args: {
    name: string;
    baseUrl?: () => string;
    key: () => string | undefined;
    models: string[];
    defaultModel: () => string;
}): ProviderClient {
    const { name, key, models, defaultModel } = args;
    const base = args.baseUrl ?? (() => 'https://api.anthropic.com/v1');
    const chat = async (req: LlmRequest, model: string, stream: boolean, onDelta: StreamFn): Promise<ChatOutcome> => {
        const k = key();
        if (!k)
            throw Object.assign(new Error(`${name}: missing API key`), { status: 401 });
        const payload = {
            model,
            system: req.system,
            messages: anthropicMessages(req.messages),
            max_tokens: req.maxTokens ?? 2600,
            temperature: req.temperature ?? 0.1,
            stream,
            ...(req.tools?.length
                ? {
                    tools: req.tools.map((spec) => ({
                        name: spec.name,
                        description: spec.description,
                        input_schema: spec.parameters,
                    })),
                }
                : {}),
        };
        const prepared = preparePost(req, {
            url: `${base().replace(/\/$/, '')}/messages`,
            payload,
            headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
            timeoutMs: stream ? 0 : 180000,
        });
        const response = await fetch(prepared.url, {
            method: 'POST',
            headers: prepared.headers,
            body: prepared.body,
            signal: prepared.signal,
        });
        if (!response.ok)
            throw await httpFailure(name, response);
        let text = '';
        const calls: Array<{
            id: string;
            name: string;
            json: string;
        }> = [];
        let usage: LlmResult['usage'];
        if (stream && response.body) {
            for await (const event of sseData(response)) {
                let record: {
                    type?: string;
                    delta?: {
                        text?: string;
                        partial_json?: string;
                    };
                    message?: {
                        usage?: unknown;
                    };
                    usage?: unknown;
                    index?: number;
                    content_block?: {
                        id?: string;
                        name?: string;
                    };
                };
                try {
                    record = JSON.parse(event);
                }
                catch {
                    continue;
                }
                if (record.type === 'message_start' && record.message?.usage) {
                    usage = extractUsage(record.message.usage);
                }
                if (record.type === 'content_block_start' && record.content_block?.name) {
                    calls[record.index ?? calls.length] = { id: record.content_block.id ?? '', name: record.content_block.name, json: '' };
                }
                if (record.type === 'content_block_delta') {
                    if (record.delta?.text) {
                        text += record.delta.text;
                        onDelta(record.delta.text, null);
                    }
                    if (record.delta?.partial_json) {
                        const call = calls[record.index ?? 0];
                        if (call)
                            call.json += record.delta.partial_json;
                    }
                }
                if (record.type === 'message_delta' && record.delta) {
                    const deltaUsage = extractUsage(record.usage);
                    if (deltaUsage)
                        usage = { input: deltaUsage.input || usage?.input || 0, output: deltaUsage.output };
                }
            }
        }
        else {
            const json = (await response.json()) as {
                content?: Array<{
                    type?: string;
                    text?: string;
                    id?: string;
                    name?: string;
                    input?: unknown;
                }>;
                usage?: unknown;
            };
            for (const part of json.content ?? []) {
                if (part.type === 'text' && part.text)
                    text += part.text;
                if (part.type === 'tool_use' && part.name) {
                    calls.push({ id: part.id ?? '', name: part.name, json: JSON.stringify(part.input ?? {}) });
                }
            }
            usage = extractUsage(json.usage);
        }
        return {
            text,
            calls: calls.filter(Boolean).map((c, index) => ({ id: c.id || `call_${index}`, name: c.name, args: c.json.trim() || '{}' })),
            usage,
        };
    };
    return buildClient(name, chat, { models, defaultModel, hasKey: () => (key() ?? '').length > 0 });
}
// ─── Gemini ─────────────────────────────────────────────────────────────────
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export function geminiClient(args: {
    name: string;
    key: () => string | undefined;
    models: string[];
    defaultModel: () => string;
}): ProviderClient {
    const { name, key, models, defaultModel } = args;
    const chat = async (req: LlmRequest, model: string, stream: boolean, onDelta: StreamFn): Promise<ChatOutcome> => {
        const k = key();
        if (!k)
            throw Object.assign(new Error(`${name}: missing API key`), { status: 401 });
        const payload = {
            system_instruction: { parts: [{ text: req.system }] },
            contents: geminiMessages(req.messages),
            generationConfig: { temperature: req.temperature ?? 0.1, maxOutputTokens: req.maxTokens ?? 2600 },
            ...(req.tools?.length
                ? {
                    tools: [{
                            functionDeclarations: req.tools.map((spec) => ({
                                name: spec.name,
                                description: spec.description,
                                parameters: spec.parameters,
                            })),
                        }],
                }
                : {}),
        };
        const url = stream
            ? `${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(k)}`
            : `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(k)}`;
        const prepared = preparePost(req, { url, payload, headers: {}, timeoutMs: stream ? 0 : 180000 });
        const response = await fetch(prepared.url, {
            method: 'POST',
            headers: prepared.headers,
            body: prepared.body,
            signal: prepared.signal,
        });
        if (!response.ok)
            throw await httpFailure(name, response);
        let text = '';
        const calls: ToolCallRequest[] = [];
        let usage: LlmResult['usage'];
        const consume = (record: {
            candidates?: Array<{
                content?: {
                    parts?: Array<Record<string, unknown>>;
                };
            }>;
            usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
            };
        }) => {
            for (const part of record.candidates?.[0]?.content?.parts ?? []) {
                if (typeof part.text === 'string' && part.text) {
                    text += part.text;
                    onDelta(part.text, null);
                }
                if (part.functionCall) {
                    const fc = part.functionCall as {
                        name?: string;
                        args?: unknown;
                    };
                    if (fc.name) {
                        calls.push({ id: `call_${calls.length}`, name: fc.name, args: JSON.stringify(fc.args ?? {}) });
                    }
                }
            }
            if (record.usageMetadata?.promptTokenCount || record.usageMetadata?.candidatesTokenCount) {
                usage = {
                    input: record.usageMetadata.promptTokenCount ?? 0,
                    output: record.usageMetadata.candidatesTokenCount ?? 0,
                };
            }
        };
        if (stream && response.body) {
            for await (const event of sseData(response)) {
                try {
                    consume(JSON.parse(event));
                }
                catch {
                    continue;
                }
            }
        }
        else {
            const json = await response.json() as Awaited<Parameters<typeof consume>[0]>;
            consume(json);
        }
        return { text, calls, usage };
    };
    return buildClient(name, chat, { models, defaultModel, hasKey: () => (key() ?? '').length > 0 });
}
export function anthropicMessages(messages: import('./types.js').ProviderMessage[]): Array<{
    role: string;
    content: unknown[];
}> {
    const out: Array<{
        role: string;
        content: unknown[];
    }> = [];
    for (const message of messages) {
        if (message.role === 'system')
            continue;
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const content: unknown[] = [];
        if (message.role === 'tool')
            content.push({ type: 'tool_result', tool_use_id: message.callId, content: message.content });
        else {
            if (message.content)
                content.push({ type: 'text', text: message.content });
            for (const call of message.toolCalls ?? [])
                content.push({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.args) });
        }
        if (!content.length)
            continue;
        const previous = out[out.length - 1];
        if (previous?.role === role)
            previous.content.push(...content);
        else
            out.push({ role, content });
    }
    return out;
}
export function geminiMessages(messages: import('./types.js').ProviderMessage[]): Array<{
    role: string;
    parts: unknown[];
}> {
    const out: Array<{
        role: string;
        parts: unknown[];
    }> = [];
    for (const message of messages) {
        if (message.role === 'system')
            continue;
        const role = message.role === 'assistant' ? 'model' : 'user';
        const parts: unknown[] = [];
        if (message.role === 'tool')
            parts.push({ functionResponse: { name: message.name, response: { output: message.content } } });
        else {
            if (message.content)
                parts.push({ text: message.content });
            for (const call of message.toolCalls ?? [])
                parts.push({ functionCall: { name: call.name, args: JSON.parse(call.args) } });
        }
        if (!parts.length)
            continue;
        const previous = out[out.length - 1];
        if (previous?.role === role)
            previous.parts.push(...parts);
        else
            out.push({ role, parts });
    }
    return out;
}
