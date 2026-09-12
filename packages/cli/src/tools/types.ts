// ─── Tool System Types ──────────────────────────────────────────────────────

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  required?: boolean;
}

export interface ToolDefinition {
  id: string;
  name: string;
  category: 'issue_tracker' | 'vcs' | 'mcp' | 'filesystem' | 'utility';
  description: string;
  parameters: ToolParameter[];
  isConfigured: boolean;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  data?: unknown;
  error?: string;
}

export interface JiraConfig {
  host?: string;       // e.g. company.atlassian.net
  email?: string;
  apiToken?: string;
  projectKey?: string;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  command: string;     // e.g. "npx -y @modelcontextprotocol/server-jira"
  args?: string[];
  status: 'connected' | 'disconnected' | 'error';
}
