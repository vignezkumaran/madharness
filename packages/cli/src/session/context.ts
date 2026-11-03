// ─── Context manager: history of ResponseItems + budgeted compaction ───────
import type { ResponseItem } from '../protocol/types.js';
import { estimateTokens } from '../tokens/estimator.js';
const MAX_TOOL_OUTPUT_CHARS = 24000;
function clipItem(item: ResponseItem): ResponseItem {
    if (item.type !== 'tool-output')
        return item;
    if (item.output.length <= MAX_TOOL_OUTPUT_CHARS)
        return item;
    const head = item.output.slice(0, MAX_TOOL_OUTPUT_CHARS / 2);
    const tail = item.output.slice(-MAX_TOOL_OUTPUT_CHARS / 4);
    return {
        ...item,
        output: `${head}\n[… ${item.output.length - head.length - tail.length} chars elided …]\n${tail}`,
    };
}
export class ContextManager {
    items: ResponseItem[] = [];
    push(item: ResponseItem): void {
        this.items.push(clipItem(item));
    }
    pop(): ResponseItem | null {
        return this.items.pop() ?? null;
    }
    get last(): ResponseItem | null {
        return this.items[this.items.length - 1] ?? null;
    }
    text(): string {
        return this.items
            .map((item) => {
            switch (item.type) {
                case 'message': return item.content;
                case 'assistant-message': return item.content + (item.toolCalls?.length ? `\nTool calls: ${JSON.stringify(item.toolCalls)}` : '');
                case 'tool-output':
                    return `[${item.tool}] ${item.output}`;
                case 'compacted':
                    return item.summary;
                default:
                    return '';
            }
        })
            .filter(Boolean)
            .join('\n\n');
    }
    tokenEstimate(): number {
        return estimateTokens(JSON.stringify(this.items));
    }
    /** Compact: keep pinned head (system-ish messages) + recent tail, summarize out middle. */
    compact(summary: string, keepTail = 8, retainedChars = 6000): ResponseItem[] {
        let start = Math.max(0, this.items.length - keepTail);
        while (start > 0 && this.items[start]?.type === 'tool-output')
            start--;
        while (start < this.items.length && JSON.stringify(this.items.slice(start)).length > retainedChars) {
            start++;
            while (start < this.items.length && this.items[start].type === 'tool-output')
                start++;
        }
        const tail = this.items.slice(start);
        const replaced = this.items.length - tail.length;
        this.items = [{ type: 'compacted' as const, summary, replacedItems: replaced }, ...tail];
        return this.items.filter((item) => item.type === 'compacted');
    }
    replay(items: ResponseItem[]): void {
        this.items = items.map(clipItem);
    }
}
