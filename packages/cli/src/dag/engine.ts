import { EventEmitter } from 'events';
import type { DagNode, DagNodeExecutor, DagEvent, DagToolBridge } from './types.js';
import type { DagNodeStatus } from '../protocol/types.js';
export interface DagRunOptions {
    maxParallel: number;
    maxAttemptsPerNode: number;
    signal: AbortSignal;
}
const snapshot = (node: DagNode): DagNode => ({ ...node, dependsOn: [...node.dependsOn] });
const succeeded = (status: DagNodeStatus) => status === 'complete' || status === 'repaired';
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
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const visit = (id: string) => {
            if (visiting.has(id))
                throw new Error(`DAG cycle at ${id}`);
            if (visited.has(id))
                return;
            const node = this.nodes.get(id);
            if (!node)
                throw new Error(`Missing DAG dependency: ${id}`);
            visiting.add(id);
            node.dependsOn.forEach(visit);
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
