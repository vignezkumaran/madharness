// ─── Tool runtime types ─────────────────────────────────────────────────────
import type { Event, Risk, ToolSpec } from '../protocol/types.js';
import type { ReviewDecision } from '../protocol/types.js';
export interface ApprovalRequestBrief {
    tool: string;
    brief: string;
    risk: Risk;
}
export interface ToolContext {
    workspace: string;
    fullAccess?: boolean;
    /** Present only for agents running one task; never null in a turn. */
    signal: AbortSignal;
    /** Emits core Events to the session event channel. */
    emit: (event: Event) => void;
    /** Ask for a review decision; resolves via the approval queue. */
    requestApproval: (request: ApprovalRequestBrief) => Promise<ReviewDecision>;
    /** Extra role/tool filter applied by agent loops, not by tools themselves. */
    agent?: string;
}
export interface ToolResult {
    ok: boolean;
    output: string;
    /** true when approval was denied -> callers may stop the agent politely */
    denied?: boolean;
    /** structured payload for tools like create_plan that return machine data */
    data?: unknown;
}
export interface Tool {
    spec: ToolSpec;
    run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
export class ToolError extends Error {
    constructor(message: string, public readonly tool: string) {
        super(message);
    }
}
