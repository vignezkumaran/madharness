// ─── MCP manager: config servers -> connections -> registry bridge ─────────
// Tool schemas stay deferred until tool_search discovers them.
import { createHash } from 'crypto';
import { Risk, type ToolSpec } from '../protocol/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import type { MadConfig } from '../config/loader.js';
import { McpConnection, mcpContentToText, type McpServerConfig } from './client.js';
export class McpManager {
    private stopped = false;
    private readonly connections = new Map<string, McpConnection>();
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
    /** Bridge every server tool into the registry under `mcp_<server>_<tool>`. */
    bridgeInto(registry: ToolRegistry): Promise<void> {
        const jobs: Array<Promise<void>> = [];
        for (const [server, connection] of this.connections) {
            jobs.push(connection.listTools().then((tools) => {
                tools.forEach((tool, index) => {
                    const identity = `${server}/${tool.name}`;
                    const name = `mcp_${server}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 47) + '_' + createHash('sha256').update(identity).digest('hex').slice(0, 12);
                    if (registry.has(name))
                        return;
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
                });
            }));
        }
        return Promise.all(jobs).then(() => { });
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
    }
}
function normalize(server: McpServerConfig): McpServerConfig {
    return {
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
    };
}
