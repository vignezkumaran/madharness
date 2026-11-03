// ─── DAG types: nodes, states, execution events ─────────────────────────────
import type { DagNodeStatus } from '../protocol/types.js';
export interface DagNode {
    id: string;
    role?: import('../protocol/types.js').AgentRole;
    title: string;
    detail?: string;
    /** what this node must produce; used by the monitor for verification */
    expected?: string;
    status: DagNodeStatus;
    dependsOn: string[];
    attempts: number;
    result?: string;
    /** id of the agent this node is assigned to */
    agent?: string;
    /** agent that last modified this node */
    byAgent?: string;
}
export type DagEventType = 'created' | 'node-updated' | 'node-failed' | 'finished';
export interface DagEvent {
    type: DagEventType;
    nodeId?: string;
    node?: DagNode;
}
export type DagNodeExecutor = (node: DagNode, context: {
    signal: AbortSignal;
    readyDeps: DagNode[];
}) => Promise<{
    ok: boolean;
    result: string;
}>;
export type DagToolBridge = {
    /** Bridge for agents: tools updating node status live here as well. */
    setNodeStatus: (nodeId: string, status: DagNodeStatus, result?: string, byAgent?: string) => boolean;
    addNode: (node: {
        id: string;
        title: string;
        detail?: string;
        dependsOn: string[];
    }, byAgent?: string) => boolean;
    snapshot: () => DagNode[];
    goal: () => string;
};
