import { EventEmitter } from 'events';
import type { DagNode, DagNodeExecutor, DagEvent, DagToolBridge } from './types.js';
import type { DagNodeStatus } from '../protocol/types.js';

export interface DagRunOptions {
    maxParallel: number;
    maxAttemptsPerNode: number;
    signal: AbortSignal;
}

export interface DagGraphMetrics {
    /** |V|: Total number of task nodes */
    nodeCount: number;
    /** |E|: Total number of directed dependency edges */
    edgeCount: number;
    /** \Lambda^*: Longest dependency chain (Critical Path Length) */
    criticalPathLength: number;
    /** Critical path sequence of node IDs */
    criticalPath: string[];
    /** S_{max} = |V| / \Lambda^*: Theoretical upper bound on parallel speedup (Brent's Theorem) */
    theoreticalSpeedup: number;
    /** Directed graph density D = |E| / (|V|(|V| - 1)) */
    density: number;
}

const snapshot = (node: DagNode): DagNode => ({ ...node, dependsOn: [...node.dependsOn] });
const succeeded = (status: DagNodeStatus) => status === 'complete' || status === 'repaired';

/**
 * Industry-Grade Directed Acyclic Graph (DAG) Execution & Orchestration Engine
 * 
 * Mathematical Formulation:
 *   G = (V, E) where:
 *     V = { v_1, v_2, ..., v_n } is the set of executable task vertices.
 *     E = { (u, v) | u \in v.dependsOn } is the set of strict dependency arcs (u \prec v).
 * 
 * Invariants Enforced:
 *   1. Acyclicity: \forall cycles C = (v_1, ..., v_k, v_1), C \cap E = \emptyset.
 *   2. Causality: A node v \in V may transition to 'running' iff \forall u \in v.dependsOn,
 *      status(u) \in { 'complete', 'repaired' }.
 *   3. Bounded Concurrency: |{ v \in V | status(v) = 'running' }| \le maxParallel.
 */
export class DagEngine extends EventEmitter {
    private readonly nodes = new Map<string, DagNode>();
    private running = false;
    executor: DagNodeExecutor = async () => { throw new Error('No DAG executor configured'); };

    constructor(nodes: DagNode[] = [], public goal = '') {
        super();
        for (const node of nodes) {
            if (this.nodes.has(node.id))
                throw new Error(`Duplicate DAG node: ${node.id}`);
            this.nodes.set(node.id, snapshot(node));
        }

        // Tri-color Depth-First Search (DFS) Cycle Detection with Exact Path Tracing
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const stack: string[] = [];

        const visit = (id: string) => {
            if (visiting.has(id)) {
                const cycleStartIndex = stack.indexOf(id);
                const cyclePath = [...stack.slice(cycleStartIndex), id].join(' -> ');
                throw new Error(`DAG cycle detected: ${cyclePath} at ${id}`);
            }
            if (visited.has(id))
                return;

            const node = this.nodes.get(id);
            if (!node)
                throw new Error(`Missing DAG dependency: ${id}`);

            visiting.add(id);
            stack.push(id);
            node.dependsOn.forEach(visit);
            stack.pop();
            visiting.delete(id);
            visited.add(id);
        };

        this.nodes.forEach(node => visit(node.id));
    }

    emitEvent(event: DagEvent): void { this.emit('event', event); }

    private update(node: DagNode, status: DagNodeStatus, result?: string): void {
        node.status = status;
        if (result !== undefined)
            node.result = result;
        this.emitEvent({ type: status === 'failed' ? 'node-failed' : 'node-updated', nodeId: node.id, node: snapshot(node) });
    }

    get allNodes(): DagNode[] { return [...this.nodes.values()].map(snapshot); }

    node(id: string): DagNode | null { const node = this.nodes.get(id); return node ? snapshot(node) : null; }

    /**
     * Computes the Topological Ordering \sigma of the DAG using Kahn's Algorithm.
     * Guarantees \forall (u, v) \in E \implies \sigma(u) < \sigma(v).
     */
    topologicalSort(): string[] {
        const inDegree = new Map<string, number>();
        const outgoing = new Map<string, string[]>();

        for (const id of this.nodes.keys()) {
            inDegree.set(id, 0);
            outgoing.set(id, []);
        }

        for (const node of this.nodes.values()) {
            for (const dep of node.dependsOn) {
                inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
                outgoing.get(dep)?.push(node.id);
            }
        }

        const queue: string[] = [];
        for (const [id, deg] of inDegree.entries()) {
            if (deg === 0) queue.push(id);
        }

        const order: string[] = [];
        while (queue.length > 0) {
            const u = queue.shift()!;
            order.push(u);
            for (const v of outgoing.get(u) ?? []) {
                const nextDeg = (inDegree.get(v) ?? 1) - 1;
                inDegree.set(v, nextDeg);
                if (nextDeg === 0) queue.push(v);
            }
        }

        return order;
    }

    /**
     * Critical Path Method (CPM) & Graph Performance Metrics.
     * Computes longest dependency chain \Lambda^* and theoretical parallel speedup.
     */
    graphMetrics(): DagGraphMetrics {
        const order = this.topologicalSort();
        const dist = new Map<string, number>();
        const predecessor = new Map<string, string | null>();

        let maxDist = 0;
        let endNode = order[0] ?? '';

        for (const id of order) {
            const node = this.nodes.get(id)!;
            let bestDist = 1;
            let bestPred: string | null = null;

            for (const dep of node.dependsOn) {
                const candidate = (dist.get(dep) ?? 1) + 1;
                if (candidate > bestDist) {
                    bestDist = candidate;
                    bestPred = dep;
                }
            }

            dist.set(id, bestDist);
            predecessor.set(id, bestPred);

            if (bestDist > maxDist) {
                maxDist = bestDist;
                endNode = id;
            }
        }

        // Trace critical path backwards
        const criticalPath: string[] = [];
        let curr: string | null = endNode;
        while (curr) {
            criticalPath.unshift(curr);
            curr = predecessor.get(curr) ?? null;
        }

        const nodeCount = this.nodes.size;
        let edgeCount = 0;
        for (const node of this.nodes.values()) edgeCount += node.dependsOn.length;

        const density = nodeCount > 1 ? edgeCount / (nodeCount * (nodeCount - 1)) : 0;
        const theoreticalSpeedup = maxDist > 0 ? Math.round((nodeCount / maxDist) * 100) / 100 : 1;

        return {
            nodeCount,
            edgeCount,
            criticalPathLength: maxDist,
            criticalPath,
            theoreticalSpeedup,
            density: Math.round(density * 1000) / 1000,
        };
    }

    toolBridge(): DagToolBridge {
        return {
            setNodeStatus: (id, status, result, byAgent) => {
                const node = this.nodes.get(id);
                if (!node)
                    return false;
                // Agent reports cannot bypass execution or complete another task.
                if (byAgent) {
                    if (node.status !== 'running' || (node.agent && node.agent !== byAgent))
                        return false;
                    if (result !== undefined)
                        node.result = result;
                    this.emitEvent({ type: 'node-updated', nodeId: id, node: snapshot(node) });
                    return true;
                }
                if (this.running && node.status === 'running')
                    return false;
                this.update(node, status, result);
                return true;
            },
            addNode: (node, byAgent) => {
                if (!node.id.trim() || this.nodes.has(node.id) || node.dependsOn.some(id => !this.nodes.has(id)))
                    return false;
                const added: DagNode = { ...node, dependsOn: [...node.dependsOn], status: 'pending', attempts: 0, byAgent };
                this.nodes.set(node.id, added);
                this.emitEvent({ type: 'node-updated', nodeId: node.id, node: snapshot(added) });
                return true;
            },
            snapshot: () => this.allNodes, goal: () => this.goal,
        };
    }

    async run(options: DagRunOptions): Promise<{
        ok: boolean;
        summary: string;
    }> {
        if (this.running)
            throw new Error('DAG is already running');
        if (!Number.isInteger(options.maxParallel) || options.maxParallel < 1 || !Number.isInteger(options.maxAttemptsPerNode) || options.maxAttemptsPerNode < 1)
            throw new Error('DAG limits must be positive integers');
        this.running = true;
        const inFlight = new Map<string, Promise<void>>();
        try {
            while (!options.signal.aborted) {
                for (const node of this.nodes.values()) {
                    if (inFlight.size >= options.maxParallel)
                        break;
                    if (node.status !== 'pending' && node.status !== 'blocked')
                        continue;
                    if (node.dependsOn.some(id => !succeeded(this.nodes.get(id)!.status) || inFlight.has(id))) {
                        if (node.status !== 'blocked')
                            this.update(node, 'blocked');
                        continue;
                    }
                    node.attempts++;
                    this.update(node, 'running');
                    const job = this.execute(node, options).finally(() => inFlight.delete(node.id));
                    inFlight.set(node.id, job);
                }
                if (!inFlight.size)
                    break;
                await Promise.race(inFlight.values());
            }
            // Do not return while a cancelled executor can still write to the workspace.
            await Promise.allSettled(inFlight.values());
            for (const node of this.nodes.values()) {
                if (node.status === 'pending' || node.status === 'blocked' || node.status === 'running')
                    this.update(node, 'skipped');
            }
            const nodes = this.allNodes;
            const done = nodes.filter(n => succeeded(n.status)).length;
            const ok = nodes.length > 0 && done === nodes.length && !options.signal.aborted;
            const summary = ok ? `DAG complete: ${done} done` : `DAG incomplete: ${done} done, ${nodes.filter(n => n.status === 'failed').length} failed, ${nodes.filter(n => n.status === 'skipped').length} skipped${options.signal.aborted ? ' (cancelled)' : ''}`;
            this.emitEvent({ type: 'finished' });
            return { ok, summary };
        }
        finally {
            this.running = false;
        }
    }

    private async execute(node: DagNode, options: DagRunOptions): Promise<void> {
        try {
            const outcome = await this.executor(snapshot(node), { signal: options.signal, readyDeps: node.dependsOn.map(id => snapshot(this.nodes.get(id)!)) });
            if (options.signal.aborted)
                this.update(node, 'skipped');
            else if (outcome.ok)
                this.update(node, 'complete', outcome.result);
            else
                this.failed(node, outcome.result, options.maxAttemptsPerNode);
        }
        catch (error) {
            if (options.signal.aborted)
                this.update(node, 'skipped');
            else
                this.failed(node, (error as Error).message, options.maxAttemptsPerNode);
        }
    }

    private failed(node: DagNode, result: string, maxAttempts: number): void {
        this.update(node, 'failed', result);
        if (node.attempts < maxAttempts)
            this.update(node, 'pending');
    }
}
