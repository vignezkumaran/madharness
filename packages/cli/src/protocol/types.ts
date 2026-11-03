// ─── MAD Protocol ───────────────────────────────────────────────────────────
// Shared DTO layer. All UIs (Ink TUI, headless exec, agents) talk to the core
// through exactly two channels: Op submissions -> Event stream.
// ────────────────────────────────────────────────────────────────────────────
export type AgentRole = 'architect' | 'coder' | 'verifier' | 'debugger' | 'planner' | 'custom';
export interface ToolSpec {
    readonly name: string;
    readonly description: string;
    readonly parameters: {
        [key: string]: unknown;
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
    /** direct = always offered to the model; deferred = surfaced through tool_search; hidden = internal */
    readonly exposure: 'direct' | 'deferred' | 'hidden';
    /** read-only tools can run in parallel without approvals */
    readonly readOnly: boolean;
    /** mutates the workspace -> approval gate applies */
    readonly mutates: boolean;
}
// ─── Response items (shared message vocabulary, persisted in rollouts) ──────
export type ResponseItem = {
    type: 'message';
    role: 'user' | 'system';
    content: string;
} | {
    type: 'assistant-message';
    content: string;
    toolRuns: ToolRunRef[];
    toolCalls?: Array<{
        id: string;
        name: string;
        args: string;
    }>;
} | {
    type: 'tool-call';
    tool: string;
    args: unknown;
    agent?: string;
} | {
    type: 'tool-output';
    callId?: string;
    tool: string;
    output: string;
    exitCode: number;
} | {
    type: 'compacted';
    summary: string;
    replacedItems: number;
};
export interface ToolRunRef {
    tool: string;
    args?: unknown;
    outcome: 'ok' | 'error' | 'denied';
}
export type ApprovalPolicy = 'never' | 'on-request' | 'always';
export type ReviewDecision = 'approved-once' | 'approved-always' | 'denied';
export enum Risk {
    Read = 'read',
    Write = 'write',
    Shell = 'shell',
    ShellDestructive = 'shell-destructive'
}
// ─── Ops ────────────────────────────────────────────────────────────────────
export type Op = {
    kind: 'plan-task';
    text: string;
} | {
    kind: 'execute-plan';
} | {
    kind: 'user-message';
    text: string;
    workspace: string;
    mode: 'chat' | 'agent';
} | {
    kind: 'steer-message';
    text: string;
} | {
    kind: 'interrupt';
} | {
    kind: 'review';
    id: string;
    decision: ReviewDecision;
} | {
    kind: 'spawn-agent';
    name: string;
    role: AgentRole;
    model?: string;
    task?: string;
} | {
    kind: 'agent-message';
    name: string;
    text: string;
} | {
    kind: 'agent-task';
    name: string;
    task: string;
} | {
    kind: 'stop-agent';
    name: string;
} | {
    kind: 'start-dag';
    goal: string;
    workspace: string;
} | {
    kind: 'dag-op';
    action: 'show' | 'rerun-node';
    nodeId?: string;
} | {
    kind: 'dag-update';
    source: string;
    nodeId: string;
    status: DagNodeStatus;
    result?: string;
} | {
    kind: 'compact';
} | {
    kind: 'clear';
};
export type DagNodeStatus = 'pending' | 'running' | 'complete' | 'failed' | 'repaired' | 'skipped' | 'blocked';
// ─── Events ─────────────────────────────────────────────────────────────────
export type Event = {
    kind: 'turn-started';
    id: string;
} | {
    kind: 'delta';
    text: string | null;
    toolLabel?: string;
    streamId: string;
} | {
    kind: 'message-completed';
    text: string;
    role: 'assistant' | 'agent';
    agent?: string;
    toolRuns: ToolRunRef[];
} | {
    kind: 'tool-started';
    tool: string;
    brief: string;
    agent?: string;
} | {
    kind: 'tool-completed';
    tool: string;
    brief: string;
    ok: boolean;
    detail?: string;
    agent?: string;
} | {
    kind: 'approval-requested';
    id: string;
    tool: string;
    brief: string;
    risk: Risk;
} | {
    kind: 'approval-resolved';
    id: string;
    decision: ReviewDecision;
} | {
    kind: 'agent-spawned';
    name: string;
    role: AgentRole;
} | {
    kind: 'agent-status';
    name: string;
    status: AgentStatus;
    detail?: string;
} | {
    kind: 'agent-communication';
    from: string;
    to: string;
    text: string;
} | {
    kind: 'activity';
    phase: 'Planning' | 'Thinking' | 'Working';
} | {
    kind: 'agent-removed';
    name: string;
} | {
    kind: 'dag-created';
    goal: string;
    nodes: DagNodeInfo[];
} | {
    kind: 'dag-node';
    node: DagNodeInfo;
} | {
    kind: 'dag-finished';
    ok: boolean;
    summary: string;
} | {
    kind: 'compacted';
    summary: string;
} | {
    kind: 'token-usage';
    estimated?: boolean;
    input: number;
    output: number;
    cached?: number;
} | {
    kind: 'error';
    message: string;
    recoverable?: boolean;
    fatal?: boolean;
} | {
    kind: 'note';
    text: string;
} | {
    kind: 'turn-ended';
    ok: boolean;
};
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'stopped';
export interface DagNodeInfo {
    id: string;
    title: string;
    detail?: string;
    status: DagNodeStatus;
    dependsOn: string[];
    agent?: string;
    attempts: number;
    result?: string;
    byAgent?: string;
}
// ─── Harness event for TUI transcript ───────────────────────────────────────
export interface HarnessEntry {
    id: number;
    kind: 'user' | 'assistant' | 'tool' | 'error' | 'info' | 'dag' | 'agent' | 'approval' | 'stream';
    text: string;
    streaming?: boolean;
    at: number;
}
