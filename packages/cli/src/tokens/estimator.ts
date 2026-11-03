// ─── Token estimation + budgets ─────────────────────────────────────────────
// Single source of truth for char->token math. Prefer real provider usage
// (LlmUsage) whenever reported; estimates are the floor, never celebrated.
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}
export interface ToolBudget {
    /** hard cap in chars for any tool output fed to the model */
    charCap: number;
    /** keep this many leading lines before elision marker */
    headLines: number;
    /** keep this many trailing lines */
    tailLines: number;
}
export const DEFAULT_TOOL_BUDGET: ToolBudget = { charCap: 8000, headLines: 12, tailLines: 8 };
/** Trim a tool result with head/tail preservation and a mid-marker. */
export function truncateOutput(output: string, budget: ToolBudget = DEFAULT_TOOL_BUDGET): {
    text: string;
    truncated: boolean;
    totalLines: number;
} {
    const lines = output.split('\n');
    const totalLines = lines.length;
    if (output.length <= budget.charCap)
        return { text: output, truncated: false, totalLines };
    const marker = `\n[… output truncated; ${totalLines} lines, ~${estimateTokens(output)} tokens total …]\n`;
    const cap = Math.max(0, budget.charCap);
    if (cap <= marker.length)
        return { text: marker.slice(0, cap), truncated: true, totalLines };
    const available = cap - marker.length;
    const headCap = Math.ceil(available * 0.6);
    const tailCap = available - headCap;
    const head = lines.slice(0, budget.headLines).join('\n').slice(0, headCap);
    const tail = tailCap ? lines.slice(-budget.tailLines).join('\n').slice(-tailCap) : '';
    return { text: head + marker + tail, truncated: true, totalLines };
}
function omitMarker(omitted: number, chars: number): string {
    return `[… ${omitted} lines elided (~${tokensShorthand(chars)})]`;
}
function tokensShorthand(chars: number): string {
    const t = Math.max(1, Math.round(chars / 4));
    return t >= 1000 ? `${Math.round(t / 100) / 10}k tokens` : `${t} tokens`;
}
export type UsageKind = 'turn' | 'tool' | 'compaction';
export interface UsageRecord {
    kind: UsageKind;
    input: number;
    output: number;
    at: number;
}
/** Usage ledger: real numbers first; estimates flagged so dashboards never lie. */
export class UsageLedger {
    private readonly real: Array<{
        record: UsageRecord;
        estimated: boolean;
    }> = [];
    private cachedIsh = 0;
    addRecord(kind: UsageKind, input: number, output: number, estimatedFallback = false): void {
        this.real.push({ record: { kind, input, output, at: Date.now() }, estimated: estimatedFallback });
    }
    /** Return totals, including a `estimatedRatio` so callers can show confidence. */
    totals(): {
        input: number;
        output: number;
        total: number;
        estimated: boolean;
        recent: UsageRecord[];
    } {
        let input = 0;
        let output = 0;
        let estimated = false;
        for (const { record, estimated: wasEstimate } of this.real) {
            input += record.input;
            output += record.output;
            if (wasEstimate)
                estimated = true;
        }
        return { input, output, total: input + output, estimated, recent: this.real.slice(-20).map(({ record }) => record) };
    }
    setCacheHint(tokens: number): void {
        this.cachedIsh = tokens;
    }
    get cacheHint(): number {
        return this.cachedIsh;
    }
}
