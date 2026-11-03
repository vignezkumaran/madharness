import type { ProviderMessage } from '../providers/types.js';
import type { LlmRequest } from '../providers/types.js';
import { estimateTokens } from './estimator.js';
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
