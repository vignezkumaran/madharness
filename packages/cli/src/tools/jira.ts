import Conf from 'conf';
import type { JiraConfig, ToolResult } from './types.js';

class JiraClient {
  private configStore: Conf<Record<string, unknown>>;

  constructor() {
    this.configStore = new Conf({ projectName: 'mad-harness-jira' });
  }

  public getConfig(): JiraConfig {
    return {
      host: (this.configStore.get('host') as string) || process.env.JIRA_HOST,
      email: (this.configStore.get('email') as string) || process.env.JIRA_EMAIL,
      apiToken: (this.configStore.get('apiToken') as string) || process.env.JIRA_API_TOKEN,
      projectKey: (this.configStore.get('projectKey') as string) || process.env.JIRA_PROJECT_KEY || 'PROJ',
    };
  }

  public setConfig(config: Partial<JiraConfig>): void {
    if (config.host) this.configStore.set('host', config.host);
    if (config.email) this.configStore.set('email', config.email);
    if (config.apiToken) this.configStore.set('apiToken', config.apiToken);
    if (config.projectKey) this.configStore.set('projectKey', config.projectKey);
  }

  public isConnected(): boolean {
    const conf = this.getConfig();
    return Boolean(conf.host && conf.email && conf.apiToken);
  }

  public async getIssue(issueKey: string): Promise<ToolResult> {
    const conf = this.getConfig();
    if (!this.isConnected()) {
      return {
        success: false,
        output: 'Jira is not connected. Configure with /jira config host=<host> email=<email> token=<token>',
      };
    }

    try {
      const url = `https://${conf.host}/rest/api/3/issue/${issueKey}`;
      const auth = Buffer.from(`${conf.email}:${conf.apiToken}`).toString('base64');

      const res = await fetch(url, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        return {
          success: false,
          output: `Failed to fetch Jira ticket ${issueKey}: ${res.status} ${res.statusText}`,
        };
      }

      const data = await res.json() as any;
      const summary = data.fields?.summary || 'No summary';
      const status = data.fields?.status?.name || 'Unknown';
      const assignee = data.fields?.assignee?.displayName || 'Unassigned';

      return {
        success: true,
        output: `📌 [${issueKey}] ${summary}\nStatus: ${status} | Assignee: ${assignee}`,
        data,
      };
    } catch (err) {
      return {
        success: false,
        output: `Error connecting to Jira: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  public async createIssue(summary: string, description: string, issueType = 'Task'): Promise<ToolResult> {
    const conf = this.getConfig();
    if (!this.isConnected()) {
      return {
        success: false,
        output: 'Jira is not connected. Connect Jira first with /jira config',
      };
    }

    try {
      const url = `https://${conf.host}/rest/api/3/issue`;
      const auth = Buffer.from(`${conf.email}:${conf.apiToken}`).toString('base64');

      const body = {
        fields: {
          project: { key: conf.projectKey },
          summary,
          description: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: description }],
              },
            ],
          },
          issuetype: { name: issueType },
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        return {
          success: false,
          output: `Failed to create Jira issue: ${res.status} ${res.statusText}`,
        };
      }

      const data = await res.json() as any;
      return {
        success: true,
        output: `✓ Created Jira ticket: ${data.key} (https://${conf.host}/browse/${data.key})`,
        data,
      };
    } catch (err) {
      return {
        success: false,
        output: `Error creating Jira issue: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  public async searchIssues(jql: string): Promise<ToolResult> {
    const conf = this.getConfig();
    if (!this.isConnected()) {
      return {
        success: false,
        output: 'Jira is not connected. Use /jira config to set up.',
      };
    }

    try {
      const url = `https://${conf.host}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=5`;
      const auth = Buffer.from(`${conf.email}:${conf.apiToken}`).toString('base64');

      const res = await fetch(url, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        return {
          success: false,
          output: `Jira search error: ${res.status} ${res.statusText}`,
        };
      }

      const data = await res.json() as any;
      const issues = (data.issues || []).map((i: any) => `• [${i.key}] ${i.fields?.summary} (${i.fields?.status?.name})`);

      return {
        success: true,
        output: issues.length > 0 ? issues.join('\n') : 'No matching Jira issues found.',
        data,
      };
    } catch (err) {
      return {
        success: false,
        output: `Jira search failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

export const jiraClient = new JiraClient();
