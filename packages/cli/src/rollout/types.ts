// ─── Rollout items (the session file vocabulary, mirroring Codex rollouts) ──
import type { DagNodeInfo, ResponseItem, ToolRunRef } from '../protocol/types.js';
export interface SessionMeta {
    id: string;
    startedAt: number;
    taskId?: string;
    workspace: string;
    instruction?: string;
    provider: string;
    model: string;
}
export interface TurnContextItem {
    workspace: string;
    provider: string;
    model: string;
    startedAt: number;
}
export interface TokenUsageItem {
    turn: number;
    input: number;
    output: number;
    at: number;
}
export interface CompactedItem {
    summary: string;
    replacedItems: number;
    at: number;
}
export interface AgentDescriptor {
    name: string;
    role: string;
    model?: string;
    spawnedAt: number;
}
export type RolloutItem = {
    item: 'history-snapshot';
    items: ResponseItem[];
} | {
    item: 'session-meta';
    meta: SessionMeta;
} | {
    item: 'turn-context';
    context: TurnContextItem;
} | {
    item: 'response';
    response: ResponseItem;
} | {
    item: 'token-usage';
    usage: TokenUsageItem;
} | {
    item: 'compacted';
    compacted: CompactedItem;
} | {
    item: 'agent';
    agent: AgentDescriptor;
} | {
    item: 'tool-run';
    run: ToolRunRef & {
        agent?: string;
        output?: string;
    };
} | {
    item: 'dag-snapshot';
    goal: string;
    nodes: DagNodeInfo[];
} | {
    item: 'event';
    event: {
        fine: string;
        text: string;
        at: number;
    };
};
function isResponse(value: unknown): value is ResponseItem {
    if (!value || typeof value !== 'object')
        return false;
    const item = value as Record<string, unknown>;
    switch (item.type) {
        case 'message': return (item.role === 'user' || item.role === 'system') && typeof item.content === 'string';
        case 'assistant-message': return typeof item.content === 'string' && Array.isArray(item.toolRuns) && (!item.toolCalls || Array.isArray(item.toolCalls) && item.toolCalls.every(call => call && typeof call.id === 'string' && typeof call.name === 'string' && typeof call.args === 'string'));
        case 'tool-call': return typeof item.tool === 'string';
        case 'tool-output': return typeof item.tool === 'string' && typeof item.output === 'string' && typeof item.exitCode === 'number';
        case 'compacted': return typeof item.summary === 'string' && typeof item.replacedItems === 'number';
        default: return false;
    }
}
export function decodeRolloutLine(line: string): RolloutItem | null {
    try {
        const value = JSON.parse(line);
        if (!value || typeof value !== 'object')
            return null;
        if (value.item === 'response')
            return isResponse(value.response) ? value : null;
        if (value.item === 'history-snapshot')
            return Array.isArray(value.items) && value.items.every(isResponse) ? value : null;
        if (value.item === 'session-meta')
            return value.meta && typeof value.meta.id === 'string' && typeof value.meta.workspace === 'string' && typeof value.meta.startedAt === 'number' ? value : null;
        if (value.item === 'compacted')
            return value.compacted && typeof value.compacted.summary === 'string' && typeof value.compacted.replacedItems === 'number' ? value : null;
        return ['turn-context', 'token-usage', 'agent', 'tool-run', 'dag-snapshot', 'event'].includes(value.item) ? value : null;
    }
    catch {
        return null;
    }
}
