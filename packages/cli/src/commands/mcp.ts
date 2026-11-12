// ─── CLI command: mad mcp [list | add | remove | tools | presets] ─────────
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig } from '../config/loader.js';
import { McpConnection } from '../mcp/client.js';
import { MCP_PRESETS, parseMcpAddInput } from '../mcp/presets.js';

export const mcpCommand = new Command('mcp')
    .description('Manage Model Context Protocol (MCP) servers (GitHub, Jira, etc.)')
    .action(async () => {
        printMcpStatus();
    });

mcpCommand
    .command('list')
    .description('List configured MCP servers')
    .action(() => {
        printMcpStatus();
    });

mcpCommand
    .command('presets')
    .description('Display popular MCP server presets and copy-paste commands')
    .action(() => {
        console.log(chalk.bold('\nPopular MCP Server Presets:\n'));
        for (const preset of Object.values(MCP_PRESETS)) {
            console.log(chalk.cyan(`● ${preset.name.toUpperCase()}`) + ` — ${preset.description}`);
            console.log(`  ${chalk.green(preset.sampleCommand)}`);
            if (preset.envHelp) {
                console.log(chalk.dim(`  ${preset.envHelp}`));
            }
            console.log('');
        }
    });

mcpCommand
    .command('add [tokens...]')
    .description('Add an MCP server (e.g. mad mcp add github npx -y @modelcontextprotocol/server-github)')
    .option('--user', 'Save to user config (~/.mad/config.json) instead of project')
    .action(async (tokens: string[], options: { user?: boolean }) => {
        if (!tokens || tokens.length === 0) {
            console.log(chalk.red('Error: missing server arguments.'));
            console.log('Usage: mad mcp add <name> [command] [args...] [--env KEY=VAL]');
            console.log('       mad mcp presets (to see examples)');
            process.exitCode = 1;
            return;
        }

        try {
            const parsed = parseMcpAddInput(tokens);
            const scope = options.user ? 'user' : 'project';
            const { config } = loadConfig();

            const serverConfig = {
                command: parsed.command,
                args: parsed.args,
                env: parsed.env,
                enabled: true,
            };

            const updatedServers = {
                ...(config.mcpServers ?? {}),
                [parsed.name]: serverConfig,
            };

            saveConfig({ mcpServers: updatedServers }, scope);
            console.log(chalk.green(`✔ Added MCP server '${parsed.name}' (${scope} config)`));
            console.log(`  Command: ${parsed.command} ${parsed.args.join(' ')}`);
            if (Object.keys(parsed.env).length > 0) {
                console.log(`  Env: ${Object.keys(parsed.env).join(', ')}`);
            }
            console.log(chalk.dim('\nRun `mad mcp test ' + parsed.name + '` to verify connectivity.'));
        } catch (error) {
            console.error(chalk.red(`Error: ${(error as Error).message}`));
            process.exitCode = 1;
        }
    });

mcpCommand
    .command('remove <name>')
    .alias('rm')
    .description('Remove an MCP server from configuration')
    .option('--user', 'Remove from user config')
    .action((name: string, options: { user?: boolean }) => {
        const scope = options.user ? 'user' : 'project';
        const { config } = loadConfig();
        const current = { ...(config.mcpServers ?? {}) };

        if (!current[name]) {
            console.log(chalk.yellow(`Server '${name}' is not configured.`));
            return;
        }

        delete current[name];
        saveConfig({ mcpServers: current }, scope);
        console.log(chalk.green(`✔ Removed MCP server '${name}' from ${scope} configuration.`));
    });

mcpCommand
    .command('test <name>')
    .description('Test connecting to an MCP server and list available tools')
    .action(async (name: string) => {
        const { config } = loadConfig();
        const server = config.mcpServers?.[name];

        if (!server) {
            console.error(chalk.red(`MCP server '${name}' is not configured. Use \`mad mcp add\` first.`));
            process.exitCode = 1;
            return;
        }

        console.log(chalk.cyan(`Testing connection to '${name}'...`));
        const connection = new McpConnection(name, {
            command: server.command,
            args: server.args ?? [],
            env: server.env ?? {},
            enabled: true,
        }, line => console.log(chalk.dim(`  [log] ${line}`)));

        try {
            await connection.start();
            console.log(chalk.green(`✔ Successfully connected to '${name}'!`));
            const tools = await connection.listTools();
            console.log(chalk.bold(`\nAvailable Tools (${tools.length}):`));
            for (const tool of tools) {
                console.log(`  • ${chalk.bold(tool.name)}: ${tool.description ?? 'No description'}`);
            }
        } catch (error) {
            console.error(chalk.red(`✖ Failed to connect to '${name}': ${(error as Error).message}`));
            process.exitCode = 1;
        } finally {
            connection.stop();
        }
    });

function printMcpStatus(): void {
    const { config, layers } = loadConfig();
    const servers = Object.entries(config.mcpServers ?? {});

    console.log(chalk.bold('\nMAD Harness — MCP (Model Context Protocol) Status'));
    console.log(chalk.dim(`Config layers: ${layers.join(', ') || 'defaults'}\n`));

    if (servers.length === 0) {
        console.log(chalk.yellow('No MCP servers configured yet.\n'));
        console.log('Connect services like GitHub, Jira, Git, or custom servers:');
        console.log(chalk.green('  mad mcp add github npx -y @modelcontextprotocol/server-github --env GITHUB_PERSONAL_ACCESS_TOKEN=<token>'));
        console.log(chalk.green('  mad mcp add jira npx -y @atlassian/jira-mcp-server --env JIRA_URL=<url> --env JIRA_EMAIL=<email> --env JIRA_API_TOKEN=<token>'));
        console.log(chalk.green('  mad mcp presets\n'));
        return;
    }

    console.log(chalk.bold(`Configured Servers (${servers.length}):`));
    for (const [name, srv] of servers) {
        const status = srv.enabled === false ? chalk.yellow('(disabled)') : chalk.green('(enabled)');
        console.log(`  ● ${chalk.bold(name)} ${status}`);
        console.log(`    Command: ${srv.command} ${(srv.args ?? []).join(' ')}`);
        if (srv.env && Object.keys(srv.env).length > 0) {
            console.log(`    Env: ${Object.keys(srv.env).join(', ')}`);
        }
    }
    console.log('\nUse `mad mcp test <name>` to test connectivity.');
    console.log('Inside the TUI interactive session, use `/mcp` or `/mcp add ...` to infuse MCP tools.\n');
}
