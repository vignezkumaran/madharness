// ─── DAG tools exposed to agents: they push their work-status into the DAG ──
import type { Tool, ToolResult, ToolContext } from '../tools/types.js';
import type { DagToolBridge } from './types.js';
import type { ToolSpec } from '../protocol/types.js';
function bridgeSpec(name: string, description: string, properties: ToolSpec['parameters']['properties'], required: string[], mutates: boolean, readOnly: boolean): ToolSpec {
    return { name, description, parameters: { type: 'object', properties, required }, exposure: 'direct', readOnly, mutates };
}
export function dagTools(bridgeRef: {
    bridge: DagToolBridge | null;
}): Tool[] {
    const dag_view: Tool = {
        spec: bridgeSpec('dag_view', 'Show the current workflow DAG: node ids, states, dependencies, results.', {}, [], false, true),
        async run(_args: Record<string, unknown>): Promise<ToolResult> {
            const bridge = bridgeRef.bridge;
            if (!bridge)
                return { ok: false, output: 'no active DAG' };
            const nodes = bridge.snapshot();
            const rows = nodes.map((node) => {
                const deps = node.dependsOn.length ? ` deps=[${node.dependsOn.join(',')}]` : '';
                const result = node.result ? ` result=${node.result.slice(0, 120)}` : '';
                return `${node.id}: ${node.status}${deps} — ${node.title}${result}`;
            });
            return { ok: true, output: `Goal: ${bridge.goal()}\n${rows.join('\n')}` };
        },
    };
    const dag_update: Tool = {
        spec: bridgeSpec('dag_update', 'Report progress for your running DAG node. The scheduler assigns final status when the worker finishes.', { node_id: { type: 'string' }, status: { type: 'string', description: 'complete | failed | running | blocked' }, result: { type: 'string', description: 'one-line result summary' } }, ['node_id', 'status'], true, false),
        async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
            const bridge = bridgeRef.bridge;
            if (!bridge)
                return { ok: false, output: 'no active DAG' };
            const status = String(args.status ?? 'complete');
            const allowed: Array<'complete' | 'failed' | 'running' | 'blocked'> = ['complete', 'failed', 'running', 'blocked'];
            if (!allowed.includes(status as never))
                return { ok: false, output: `status must be one of: ${allowed.join(', ')}` };
            const changed = bridge.setNodeStatus(String(args.node_id), status as 'complete', args.result === undefined ? undefined : String(args.result), ctx.agent);
            return changed
                ? { ok: true, output: `Progress recorded for ${String(args.node_id)}; final status is assigned after worker completion` }
                : { ok: false, output: `unknown node: ${String(args.node_id)}` };
        },
    };
    const dag_add_node: Tool = {
        spec: bridgeSpec('dag_add_node', 'Add a follow-up node to the DAG (id must be new, deps must exist).', { id: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } } }, ['id', 'title'], true, false),
        async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
            const bridge = bridgeRef.bridge;
            if (!bridge)
                return { ok: false, output: 'no active DAG' };
            const dependsOn = Array.isArray(args.depends_on)
                ? (args.depends_on as unknown[]).map((dep) => String(dep)).filter(Boolean)
                : [];
            const added = bridge.addNode({ id: String(args.id), title: String(args.title), detail: args.detail ? String(args.detail) : undefined, dependsOn }, ctx.agent);
            return added
                ? { ok: true, output: `node ${String(args.id)} added (deps: ${dependsOn.join(',') || 'none'})` }
                : { ok: false, output: `node id already exists or invalid: ${String(args.id)}` };
        },
    };
    return [dag_view, dag_update, dag_add_node];
}
