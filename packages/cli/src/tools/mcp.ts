import Conf from 'conf';
import type { MCPServerConfig, ToolResult } from './types.js';

export class MCPManager {
  private configStore: Conf<Record<string, unknown>>;
  private servers: Map<string, MCPServerConfig> = new Map();

  constructor() {
    this.configStore = new Conf({ projectName: 'mad-harness-mcp' });
    this.loadSavedServers();
  }

  private loadSavedServers(): void {
    const saved = (this.configStore.get('servers') as MCPServerConfig[]) || [];
    for (const s of saved) {
      this.servers.set(s.id, s);
    }
  }

  public getServers(): MCPServerConfig[] {
    return Array.from(this.servers.values());
  }

  public addServer(name: string, command: string, args: string[] = []): ToolResult {
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const config: MCPServerConfig = {
      id,
      name,
      command,
      args,
      status: 'connected',
    };

    this.servers.set(id, config);
    this.configStore.set('servers', Array.from(this.servers.values()));

    return {
      success: true,
      output: `✓ Registered MCP Server [${name}] with command: ${command} ${args.join(' ')}`,
      data: config,
    };
  }

  public removeServer(nameOrId: string): ToolResult {
    const id = nameOrId.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const existed = this.servers.delete(id);
    if (existed) {
      this.configStore.set('servers', Array.from(this.servers.values()));
      return { success: true, output: `✓ Removed MCP server [${nameOrId}]` };
    }
    return { success: false, output: `MCP server [${nameOrId}] not found.` };
  }
}

export const mcpManager = new MCPManager();
