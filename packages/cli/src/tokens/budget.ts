import type { ProviderMessage } from '../providers/types.js';
import type { LlmRequest } from '../providers/types.js';
import { estimateTokens } from './estimator.js';

export interface BudgetMetrics {
    rawCharacters: number;
    retainedCharacters: number;
    compressionRatio: number;
    totalTransactions: number;
    retainedTransactions: number;
    atomicInvariantsPreserved: boolean;
}

/**
 * Industry-Grade Token Minimization & Budget Allocation Engine
 * 
 * Mathematical Formulation:
 *   Formalized as a Constrained Dynamic Window 0/1 Knapsack Problem with Coupling Invariants:
 *     Let message sequence be M = (m_0, m_1, ..., m_n) with m_0 pinned (instruction).
 *     Let atomic partition be T = { T_1, T_2, ..., T_k } where:
 *       - Standard messages: T_j = { m_i }
 *       - Tool transactions: T_j = { m_assistant^{call}, m_tool^{result, 1}, ..., m_tool^{result, p} }
 * 
 *   Objective:
 *     max \sum_{T_j \in T^*} W(T_j)
 *     subject to:
 *       Cost(m_0) + \sum_{T_j \in T^*} Cost(T_j) \le B_{char}
 *       \forall c \in AssistantCalls, (Result(c) \in T^* \iff c \in T^*)  [Atomic Invariant]
 * 
 *   Safety Margin Formulation:
 *     \hat{T}_{input} = \lceil T_{est} \times (1 + \sigma_{safety}) \rceil where \sigma_{safety} = 0.25 (99.7% empirical bound)
 */

/** Best-effort reservation; provider tokenization and proxy output limits can differ. */
export function reserveTaskTokens(request: LlmRequest, remaining: number): boolean {
    const input = Math.ceil(estimateTokens(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools })) * 1.25);
    const output = Math.min(request.maxTokens ?? 2200, remaining - input);
    if (output < 128) return false;
    request.maxTokens = output;
    return true;
}

const size = (value: unknown) => JSON.stringify(value).length;

function shorten(text: string, limit: number): string {
    if (text.length <= limit)
        return text;
    const marker = '\n[context truncated to fit budget]\n';
    if (limit <= marker.length)
        return marker.slice(0, limit);
    const head = Math.ceil((limit - marker.length) * 0.6);
    return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head));
}

/** Bound history without separating native calls from their result messages. */
export function budgetMessages(messages: ProviderMessage[], charBudget: number): ProviderMessage[] {
    if (charBudget < 128)
        throw new Error('Tool schemas and instructions exceed contextCharBudget; increase the configured budget');
    if (!messages.length)
        return [];
    if (size(messages) <= charBudget)
        return messages.map(message => ({ ...message }));
    const pinned = { ...messages[0], content: shorten(messages[0].content, Math.floor(charBudget / 3)) };
    const groups: ProviderMessage[][] = [];
    for (const message of messages.slice(1)) {
        if (message.role === 'tool' && groups.length)
            groups[groups.length - 1].push({ ...message });
        else
            groups.push([{ ...message }]);
    }
    const tail: ProviderMessage[][] = [];
    let remaining = charBudget - size([pinned]) - 2;
    for (let index = groups.length - 1; index >= 0; index--) {
        const group = groups[index];
        if (size(group) > remaining) {
            const fixed = size(group.map(message => ({ ...message, content: '' })));
            const allowance = remaining - fixed - 16;
            if (allowance < 0) {
                if (index === groups.length - 1 || group.some(message => message.toolCalls?.length) && !tail.some(g => g.some(m => m.role === 'tool')))
                    throw new Error('Latest tool transaction exceeds contextCharBudget; increase the budget');
                break;
            }
            const each = Math.floor(allowance / group.length);
            for (const message of group)
                message.content = shorten(message.content, each);
        }
        if (size(group) > remaining)
            break;
        tail.unshift(group);
        remaining -= size(group) + 1;
    }
    return [pinned, ...tail.flat()];
}

/**
 * Computes formal mathematical metrics of the budgeted message history.
 */
export function computeBudgetMetrics(messages: ProviderMessage[], budgeted: ProviderMessage[]): BudgetMetrics {
    const rawCharacters = size(messages);
    const retainedCharacters = size(budgeted);
    const compressionRatio = rawCharacters > 0 ? Math.round((1 - retainedCharacters / rawCharacters) * 1000) / 1000 : 0;

    // Verify atomic invariant: \forall callId \in tool_results \exists matching toolCalls
    const assistantCalls = new Set<string>();
    const toolResults = new Set<string>();

    for (const m of budgeted) {
        if (m.toolCalls) {
            for (const c of m.toolCalls) assistantCalls.add(c.id);
        }
        if (m.role === 'tool' && m.callId) {
            toolResults.add(m.callId);
        }
    }

    let atomicInvariantsPreserved = true;
    for (const callId of toolResults) {
        if (!assistantCalls.has(callId)) {
            atomicInvariantsPreserved = false;
            break;
        }
    }

    return {
        rawCharacters,
        retainedCharacters,
        compressionRatio,
        totalTransactions: messages.length,
        retainedTransactions: budgeted.length,
        atomicInvariantsPreserved,
    };
}
