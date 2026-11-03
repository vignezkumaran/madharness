// ─── Provider types: one unified wire-vocabulary for every backend ──────────
import type { ResponseItem, ToolSpec } from '../protocol/types.js';
export interface ProviderMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: ToolCallRequest[];
    callId?: string;
    name?: string;
}
export interface LlmRequest {
    workspace?: string;
    system: string;
    messages: ProviderMessage[];
    tools?: ToolSpec[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
}
export interface ToolCallRequest {
    id: string;
    name: string;
    args: string;
}
export interface LlmUsage {
    estimated?: boolean;
    input: number;
    output: number;
}
export interface LlmResult {
    text: string;
    toolCalls: ToolCallRequest[];
    usage?: LlmUsage;
}
export interface ProviderClient {
    readonly name: string;
    readonly models: string[];
    readonly streaming: boolean;
    readonly toolProtocol?: 'native' | 'text';
    initialize?():Promise<void>;
    close?(): void | Promise<void>;
    defaultModel(): string;
    hasKey(): boolean;
    complete(req: LlmRequest): Promise<LlmResult>;
    stream(req: LlmRequest, onDelta: (text: string | null, record: unknown) => void): Promise<LlmResult>;
}
/** Convert canonical ResponseItem[]-backed history into wire messages */
export function renderMessages(system: string, items: ResponseItem[]): ProviderMessage[] {
    const out: ProviderMessage[] = system ? [{ role: 'system', content: system }] : [];
    for (const item of items) {
        switch (item.type) {
            case 'message':
                out.push({ role: item.role, content: item.content });
                break;
            case 'assistant-message':
                if (item.content || item.toolCalls?.length)
                    out.push({ role: 'assistant', content: item.content, toolCalls: item.toolCalls });
                break;
            case 'tool-output':
                out.push(item.callId ? { role: 'tool', callId: item.callId, name: item.tool, content: item.output } : { role: 'user', content: `[tool ${item.tool} result]\n${item.output}` });
                break;
            case 'compacted':
                out.push({ role: 'user', content: `[conversation compacted]\n${item.summary}` });
                break;
        }
    }
    return out;
}
export function toolSpecToOpenAi(tools: ToolSpec[]): Array<{
    type: string;
    function: Record<string, unknown>;
}> {
    return tools.map((spec) => ({
        type: 'function',
        function: {
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
        },
    }));
}
