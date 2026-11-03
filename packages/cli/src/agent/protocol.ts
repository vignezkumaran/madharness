// ─── Reply protocol: robust extraction of the agent JSON envelope ───────────
export interface AgentAction {
    tool: string;
    args: Record<string, unknown>;
}
export interface AgentReply {
    kind: 'action' | 'done' | 'invalid';
    action?: AgentAction;
    summary?: string;
    text?: string;
}
function firstJsonObject(text: string): {
    json: string;
    start: number;
    end: number;
} | null {
    let start = text.indexOf('{');
    while (start !== -1) {
        // find matching brace respecting strings
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (escaped)
                    escaped = false;
                else if (char === '\\')
                    escaped = true;
                else if (char === '"')
                    inString = false;
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '{')
                depth++;
            else if (char === '}') {
                depth--;
                if (depth === 0) {
                    return { json: text.slice(start, index + 1), start, end: index + 1 };
                }
            }
        }
        start = text.indexOf('{', start + 1);
    }
    return null;
}
export function parseAgentReply(text: string): AgentReply {
    const found = firstJsonObject(text);
    if (!found) {
        return { kind: 'invalid', text };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(found.json);
    }
    catch {
        return { kind: 'invalid', text };
    }
    if (!parsed || typeof parsed !== 'object')
        return { kind: 'invalid', text };
    const record = parsed as {
        action?: {
            tool?: unknown;
            args?: unknown;
        };
        done?: unknown;
        summary?: unknown;
    };
    if (record.done === true) {
        return { kind: 'done', summary: typeof record.summary === 'string' ? record.summary : text.replace(found.json, '').trim() };
    }
    if (record.action && typeof record.action === 'object') {
        const tool = String(record.action.tool ?? '').trim();
        if (!tool)
            return { kind: 'invalid', text };
        const args = (record.action.args && typeof record.action.args === 'object' ? record.action.args : {}) as Record<string, unknown>;
        return { kind: 'action', action: { tool, args } };
    }
    return { kind: 'invalid', text };
}
