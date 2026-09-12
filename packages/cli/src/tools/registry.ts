import type { ToolDefinition, ToolResult } from './types.js';
import { jiraClient } from './jira.js';
import { gitTool } from './git.js';
import { mcpManager } from './mcp.js';
import * as fs from 'fs';
import * as path from 'path';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.registerBuiltins();
  }

  private registerBuiltins(): void {
    // ── Jira Tools ──────────────────────────────────────────────────────────
    this.register({
      id: 'jira_get_issue',
      name: 'Get Jira Issue',
      category: 'issue_tracker',
      description: 'Fetch details, status, and summary of a Jira ticket',
      parameters: [
        { name: 'issueKey', type: 'string', description: 'e.g. PROJ-123', required: true },
      ],
      isConfigured: jiraClient.isConnected(),
      execute: async (args) => jiraClient.getIssue(String(args.issueKey || '')),
    });

    this.register({
      id: 'jira_create_issue',
      name: 'Create Jira Issue',
      category: 'issue_tracker',
      description: 'Create a new issue/bug/task in Jira',
      parameters: [
        { name: 'summary', type: 'string', description: 'Issue summary title', required: true },
        { name: 'description', type: 'string', description: 'Detailed issue description', required: true },
      ],
      isConfigured: jiraClient.isConnected(),
      execute: async (args) =>
        jiraClient.createIssue(String(args.summary || ''), String(args.description || '')),
    });

    this.register({
      id: 'jira_search',
      name: 'Search Jira Issues',
      category: 'issue_tracker',
      description: 'Search Jira issues using JQL query',
      parameters: [
        { name: 'jql', type: 'string', description: 'JQL query string', required: true },
      ],
      isConfigured: jiraClient.isConnected(),
      execute: async (args) => jiraClient.searchIssues(String(args.jql || '')),
    });

    // ── Git Tools ───────────────────────────────────────────────────────────
    this.register({
      id: 'git_status',
      name: 'Git Status',
      category: 'vcs',
      description: 'Show current git branch and uncommitted modifications',
      parameters: [],
      isConfigured: true,
      execute: async () => gitTool.getStatus(),
    });

    this.register({
      id: 'git_diff',
      name: 'Git Diff',
      category: 'vcs',
      description: 'Show code changes in current git repository',
      parameters: [
        { name: 'cached', type: 'boolean', description: 'View staged diff', required: false },
      ],
      isConfigured: true,
      execute: async (args) => gitTool.getDiff(Boolean(args.cached)),
    });

    // ── File System Tools ───────────────────────────────────────────────────
    this.register({
      id: 'read_file',
      name: 'Read Local File',
      category: 'filesystem',
      description: 'Read the contents of a local file in workspace',
      parameters: [
        { name: 'filePath', type: 'string', description: 'Relative path to file', required: true },
      ],
      isConfigured: true,
      execute: async (args) => {
        try {
          const p = path.resolve(process.cwd(), String(args.filePath || ''));
          if (!fs.existsSync(p)) return { success: false, output: `File not found: ${args.filePath}` };
          const content = fs.readFileSync(p, 'utf-8');
          return { success: true, output: content.slice(0, 5000) };
        } catch (err) {
          return { success: false, output: `Read error: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });
  }

  public register(tool: ToolDefinition): void {
    this.tools.set(tool.id, tool);
  }

  public getTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => {
      if (t.category === 'issue_tracker') {
        t.isConfigured = jiraClient.isConnected();
      }
      return t;
    });
  }

  public async executeTool(id: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(id);
    if (!tool) return { success: false, output: `Tool [${id}] is not registered.` };
    return tool.execute(args);
  }
}

export const toolRegistry = new ToolRegistry();
export { jiraClient } from './jira.js';
export { gitTool } from './git.js';
export { mcpManager } from './mcp.js';
