// ─── MCP manager: config servers -> connections -> registry bridge ─────────
// Tool schemas stay deferred until tool_search discovers them.
import { createHash } from 'crypto';
import { Risk, type ToolSpec } from '../protocol/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import type { MadConfig } from '../config/loader.js';
import { McpConnection, mcpContentToText, type McpServerConfig, type McpToolInfo } from './client.js';

export class McpManager {
    private stopped = false;
    private readonly connections = new Map<string, McpConnection>();
    private readonly serverToolNames = new Map<string, Set<string>>();
    private currentRegistry: ToolRegistry | null = null;

    async start(config: MadConfig, log: (line: string) => void): Promise<void> {
        if (this.stopped)
            throw new Error('MCP manager is stopped');
        const entries = Object.entries(config.mcpServers ?? {}).filter(([, server]) => server.enabled !== false);
        const results = await Promise.allSettled(entries.map(async ([name, server]) => {
            if (this.connections.has(name))
                return;
            const connection = new McpConnection(name, normalize(server), log);
            this.connections.set(name, connection);
            try {
                await connection.start();
            }
            catch (error) {
                connection.stop();
                this.connections.delete(name);
                throw error;
            }
            if (this.stopped) {
                connection.stop();
                return;
            }
            log(`mcp: connected ${name}`);
        }));
        for (const [index, result] of results.entries()) {
            if (result.status === 'rejected') {
                log(`mcp: failed to start ${entries[index][0]}: ${(result.reason as Error).message}`);
            }
        }
    }

    /** Register all tools for a single server into the registry. */
    private async bridgeServerTools(server: string, connection: McpConnection, registry: ToolRegistry): Promise<string[]> {
        const tools = await connection.listTools();
        const registeredNames = this.serverToolNames.get(server) ?? new Set<string>();
        const namesAdded: string[] = [];

        for (const tool of tools) {
            const identity = `${server}/${tool.name}`;
            const name = `mcp_${server}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 47) + '_' + createHash('sha256').update(identity).digest('hex').slice(0, 12);
            if (registry.has(name)) {
                registeredNames.add(name);
                continue;
            }
            const spec: ToolSpec = {
                name,
                description: tool.description
                    ? `${tool.description} (mcp:${server})`
                    : `MCP tool ${tool.name} from server ${server}`,
                parameters: tool.inputSchema && tool.inputSchema.type === 'object' ? { ...tool.inputSchema, type: 'object' as const, properties: tool.inputSchema.properties ?? {} } : { type: 'object', properties: {} },
                exposure: 'deferred',
                readOnly: false,
                mutates: true,
            };
            registry.register({
                spec,
                run: async (args, ctx): Promise<ToolResult> => {
                    if (ctx.signal.aborted)
                        return { ok: false, output: 'Cancelled' };
                    const decision = await ctx.requestApproval({ tool: name, brief: JSON.stringify(args), risk: Risk.Write });
                    if (decision === 'denied')
                        return { ok: false, denied: true, output: 'Denied' };
                    const output = await this.callTool(server, tool.name, args, ctx.signal);
                    return { ok: !output.startsWith('MCP tool error'), output };
                },
            });
            registeredNames.add(name);
            namesAdded.push(name);
        }
        this.serverToolNames.set(server, registeredNames);
        return namesAdded;
    }

    /** Bridge every server tool into the registry under `mcp_<server>_<tool>`. */
    async bridgeInto(registry: ToolRegistry): Promise<void> {
        this.currentRegistry = registry;
        const jobs: Array<Promise<string[]>> = [];
        for (const [server, connection] of this.connections) {
            jobs.push(this.bridgeServerTools(server, connection, registry));
        }
        await Promise.all(jobs);
    }

    /** Add and connect a new MCP server dynamically, optionally bridging into registry. */
    async addServer(
        name: string,
        server: McpServerConfig,
        log: (line: string) => void = () => { },
        registry?: ToolRegistry
    ): Promise<{ tools: McpToolInfo[]; toolNames: string[] }> {
        this.stopped = false;
        const targetRegistry = registry ?? this.currentRegistry;

        if (this.connections.has(name)) {
            await this.removeServer(name, targetRegistry ?? undefined);
        }

        const connection = new McpConnection(name, normalize(server), log);
        this.connections.set(name, connection);

        try {
            await connection.start();
        } catch (error) {
            connection.stop();
            this.connections.delete(name);
            throw error;
        }

        const tools = await connection.listTools();
        let toolNames: string[] = [];
        if (targetRegistry) {
            toolNames = await this.bridgeServerTools(name, connection, targetRegistry);
        }

        log(`mcp: connected ${name} (${tools.length} tools)`);
        return { tools, toolNames };
    }

    /** Remove an MCP server and unregister its tools from the registry. */
    removeServer(name: string, registry?: ToolRegistry): boolean {
        const targetRegistry = registry ?? this.currentRegistry;
        const toolNames = this.serverToolNames.get(name);
        if (toolNames && targetRegistry) {
            for (const toolName of toolNames) {
                targetRegistry.unregister(toolName);
            }
        }
        this.serverToolNames.delete(name);

        const connection = this.connections.get(name);
        if (connection) {
            connection.stop();
            this.connections.delete(name);
            return true;
        }
        return false;
    }

    /** List all active MCP server connections and their status. */
    listServers(): Array<{ name: string; connected: boolean; tools: McpToolInfo[] }> {
        const list: Array<{ name: string; connected: boolean; tools: McpToolInfo[] }> = [];
        for (const [name, conn] of this.connections) {
            list.push({
                name,
                connected: conn.isRunning(),
                tools: (conn as unknown as { tools: McpToolInfo[] | null }).tools ?? [],
            });
        }
        return list;
    }

    /** Get tools from all or specific MCP servers. */
    async getTools(serverName?: string): Promise<Array<{ server: string; tool: McpToolInfo; registeredName?: string }>> {
        const results: Array<{ server: string; tool: McpToolInfo; registeredName?: string }> = [];
        for (const [server, conn] of this.connections) {
            if (serverName && server !== serverName)
                continue;
            const tools = await conn.listTools();
            for (const tool of tools) {
                const identity = `${server}/${tool.name}`;
                const registeredName = `mcp_${server}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 47) + '_' + createHash('sha256').update(identity).digest('hex').slice(0, 12);
                results.push({ server, tool, registeredName });
            }
        }
        return results;
    }

    private async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
        const connection = this.connections.get(server);
        if (!connection)
            return `MCP tool error: server ${server} is not connected`;
        try {
            return mcpContentToText(await connection.callTool(tool, args, signal));
        }
        catch (error) {
            return `MCP tool error: ${(error as Error).message}`;
        }
    }

    stop(): void {
        this.stopped = true;
        for (const connection of this.connections.values())
            connection.stop();
        this.connections.clear();
        this.serverToolNames.clear();
        this.currentRegistry = null;
    }
}

function normalize(server: McpServerConfig): McpServerConfig {
    return {
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        enabled: server.enabled ?? true,
    };
}
