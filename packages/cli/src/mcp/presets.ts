// ─── MCP Presets and argument parser for /mcp add ───────────────────────

export interface McpPreset {
    name: string;
    description: string;
    command: string;
    args: string[];
    requiredEnv?: string[];
    envHelp?: string;
    sampleCommand: string;
}

export const MCP_PRESETS: Record<string, McpPreset> = {
    github: {
        name: 'github',
        description: 'GitHub: manage issues, PRs, repositories, files, and branches',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        requiredEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
        envHelp: 'Create a personal access token at https://github.com/settings/tokens (classic with repo or fine-grained)',
        sampleCommand: '/mcp add github npx -y @modelcontextprotocol/server-github --env GITHUB_PERSONAL_ACCESS_TOKEN=<token>',
    },
    jira: {
        name: 'jira',
        description: 'Atlassian Jira: create, search, update, and manage Jira issues',
        command: 'npx',
        args: ['-y', '@atlassian/jira-mcp-server'],
        requiredEnv: ['JIRA_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
        envHelp: 'Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens',
        sampleCommand: '/mcp add jira npx -y @atlassian/jira-mcp-server --env JIRA_URL=https://<domain>.atlassian.net --env JIRA_EMAIL=<email> --env JIRA_API_TOKEN=<token>',
    },
    git: {
        name: 'git',
        description: 'Git: inspect git repositories, commits, branches, and diffs',
        command: 'uvx',
        args: ['mcp-server-git'],
        sampleCommand: '/mcp add git uvx mcp-server-git',
    },
    fetch: {
        name: 'fetch',
        description: 'Web Fetch: download web pages and convert to markdown',
        command: 'uvx',
        args: ['mcp-server-fetch'],
        sampleCommand: '/mcp add fetch uvx mcp-server-fetch',
    },
    memory: {
        name: 'memory',
        description: 'Persistent Memory: store and retrieve entity graphs across sessions',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        sampleCommand: '/mcp add memory npx -y @modelcontextprotocol/server-memory',
    },
    filesystem: {
        name: 'filesystem',
        description: 'Filesystem: secure file access for specific allowed paths',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        sampleCommand: '/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .',
    },
    'brave-search': {
        name: 'brave-search',
        description: 'Brave Search: web and local search',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-brave-search'],
        requiredEnv: ['BRAVE_API_KEY'],
        envHelp: 'Get an API key at https://brave.com/search/api/',
        sampleCommand: '/mcp add brave-search npx -y @modelcontextprotocol/server-brave-search --env BRAVE_API_KEY=<key>',
    },
    slack: {
        name: 'slack',
        description: 'Slack: list channels, post messages, and read history',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-slack'],
        requiredEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
        sampleCommand: '/mcp add slack npx -y @modelcontextprotocol/server-slack --env SLACK_BOT_TOKEN=<token> --env SLACK_TEAM_ID=<id>',
    },
    postgres: {
        name: 'postgres',
        description: 'PostgreSQL: read schemas, tables, and execute SQL queries',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres'],
        sampleCommand: '/mcp add postgres npx -y @modelcontextprotocol/server-postgres postgresql://user:password@localhost/dbname',
    },
};

export function parseMcpAddInput(tokens: string[]): {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
} {
    const env: Record<string, string> = {};
    const nonEnvTokens: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '--env' || token === '-e') {
            const next = tokens[++i];
            if (!next || !next.includes('=')) {
                throw new Error('Expected KEY=VALUE after ' + token);
            }
            const eq = next.indexOf('=');
            env[next.slice(0, eq)] = next.slice(eq + 1);
        } else if (token.startsWith('--env=') || token.startsWith('-e=')) {
            const pair = token.replace(/^--?env=/, '');
            const eq = pair.indexOf('=');
            if (eq <= 0) throw new Error('Expected KEY=VALUE in --env=');
            env[pair.slice(0, eq)] = pair.slice(eq + 1);
        } else if (token.includes('=') && /^[A-Z0-9_]+=/.test(token)) {
            const eq = token.indexOf('=');
            env[token.slice(0, eq)] = token.slice(eq + 1);
        } else {
            nonEnvTokens.push(token);
        }
    }

    if (nonEnvTokens.length === 0) {
        throw new Error('Usage: /mcp add <name> [command] [args...] [--env KEY=VAL]');
    }

    const name = nonEnvTokens[0].toLowerCase();
    const preset = MCP_PRESETS[name];

    if (nonEnvTokens.length === 1) {
        if (preset) {
            if (preset.requiredEnv) {
                const missing = preset.requiredEnv.filter(k => !env[k] && !process.env[k]);
                if (missing.length > 0) {
                    throw new Error(
                        `Preset '${name}' requires environment variable(s): ${missing.join(', ')}.\n` +
                        (preset.envHelp ? `${preset.envHelp}\n` : '') +
                        `Run: ${preset.sampleCommand}`
                    );
                }
            }
            return {
                name,
                command: preset.command,
                args: [...preset.args],
                env,
            };
        }
        throw new Error(`Unknown preset '${name}'. Please specify command and args:\n/mcp add ${name} <command> [args...]`);
    }

    const command = nonEnvTokens[1];
    const args = nonEnvTokens.slice(2);
    return { name, command, args, env };
}
