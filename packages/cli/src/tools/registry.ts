// ─── Tool registry: name -> runtime + spec + exposure ───────────────────────
import type { ToolSpec, ResponseItem } from '../protocol/types.js';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { withWorkspaceLock } from './lock.js';
import { validateArguments } from './validate.js';
import {registerExposure,exposeTool,visibleTools,resetExposure,undiscoveredTools} from '../tokens/tool-exposure.js';
import { ToolError } from './types.js';
export class ToolRegistry {
    private readonly tools = new Map<string, Tool>();
    register(command: Tool): void {
        if (this.tools.has(command.spec.name)) {
            throw new Error(`Tool already registered: ${command.spec.name}`);
        }
        registerExposure(command);
        this.tools.set(command.spec.name, command);
    }
    get(name: string): Tool | null {
        return this.tools.get(name) ?? null;
    }
    has(name: string): boolean {
        return this.tools.has(name);
    }
    /** Direct-exposure specs (fed to the model). */
    listDirect(): ToolSpec[] {
        return visibleTools([...this.tools.values()]).map(tool=>tool.spec);
    }
    /** All specs incl. deferred (used by tool search). */
    listAll(): ToolSpec[] {
        return Array.from(this.tools.values()).map((tool) => tool.spec);
    }
    /** Deferred only — surfaced through tool_search to save prompt tokens. */
    listDeferred(): ToolSpec[] {
        return undiscoveredTools([...this.tools.values()]).map(tool=>tool.spec);
    }
    listTools(): Tool[] { return [...this.tools.values()]; }
    expose(name: string): void {
        const tool = this.tools.get(name);
        if(tool)exposeTool(tool);
    }
    resetDiscovery():void {resetExposure([...this.tools.values()]);}
    names(): string[] {
        return Array.from(this.tools.keys());
    }
    async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const tool = this.tools.get(name);
        if (!tool)
            return { ok: false, output: `Unknown tool: ${name}` };
        if (ctx.signal.aborted)
            return { ok: false, output: 'Cancelled' };
        const validation = validateArguments(args, tool.spec.parameters);
        if (validation)
            return { ok: false, output: `Invalid arguments: ${validation}` };
        const isObjectRecord = Boolean(args) && typeof args === 'object' && !Array.isArray(args);
        const safeArgs = (isObjectRecord ? args : {}) as Record<string, unknown>;
        ctx.emit({
            kind: 'tool-started',
            tool: name,
            brief: describeCall(tool.spec, safeArgs),
            agent: ctx.agent,
        });
        const started = Date.now();
        try {
            const result = await (tool.spec.mutates ? withWorkspaceLock(ctx.workspace, ctx.signal, () => tool.run(safeArgs, ctx)) : tool.run(safeArgs, ctx));
            ctx.emit({
                kind: 'tool-completed',
                tool: name,
                brief: describeCall(tool.spec, safeArgs),
                ok: result.ok,
                detail: result.denied ? 'denied' : undefined,
                agent: ctx.agent,
            });
            void started;
            return result;
        }
        catch (error) {
            const message = error instanceof ToolError ? error.message : `${(error as Error)?.message ?? String(error)}`;
            ctx.emit({
                kind: 'tool-completed',
                tool: name,
                brief: describeCall(tool.spec, safeArgs),
                ok: false,
                detail: message.slice(0, 200),
                agent: ctx.agent,
            });
            return { ok: false, output: `Error: ${message}` };
        }
    }
}
export function describeCall(spec: ToolSpec, args: Record<string, unknown>): string {
    const first = spec.parameters.required?.[0] ?? Object.keys(spec.parameters.properties)[0];
    const value = first !== undefined ? String(args[first] ?? '') : '';
    const secondary = Object.entries(args)
        .filter(([key]) => key !== first && typeof value !== 'undefined' && args[key] !== undefined)
        .slice(0, 1)
        .map(([key, argValue]) => `${key}=${String(argValue).slice(0, 40)}`);
    return [spec.description.split('.')[0], value.slice(0, 60), ...secondary]
        .filter(Boolean)
        .join(' ');
}
