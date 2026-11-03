import { Command } from 'commander';
import * as path from 'path';
import * as readline from 'readline/promises';
import { MadSession } from '../session/session.js';
import { loadConfig } from '../config/loader.js';
export interface AgentOnceOptions {
    prompt?: string;
    provider?: string;
    cwd?: string;
    yes?: boolean;
    plan?: boolean;
    fullAccess?: boolean;
    askPermission?: boolean;
    verbose?: boolean;
    maxRounds?: string;
}
export async function runAgentOnce(prompt: string, options: AgentOnceOptions = {}): Promise<{
    ok: boolean;
}> {
    if (options.askPermission && (options.yes || options.fullAccess))
        throw new Error('Choose --ask-permission or --full-access/--yes');
    const workspace = path.resolve(options.cwd ?? process.cwd());
    const { config } = loadConfig({ ...(options.askPermission ? { approvalPolicy: 'always' as const, fullAccess: false } : {}), ...(options.fullAccess ? { fullAccess: true } : {}), ...(options.yes || options.fullAccess ? { approvalPolicy: 'never' as const } : {}), ...(options.maxRounds ? { verifyRounds: Number(options.maxRounds) } : {}) }, workspace);
    const session = new MadSession({ workspace, config, provider: options.provider });
    const rl = process.stdin.isTTY && !options.yes && !options.fullAccess ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
    const interrupt = () => session.cancel();
    process.on('SIGINT', interrupt);
    let streamed = '';
    try {
        return await new Promise<{
            ok: boolean;
        }>((resolve) => {
            session.on(event => {
                if (event.kind === 'delta' && !event.toolLabel) {
                    if (event.text === null)
                        streamed = '';
                    else {
                        process.stdout.write(event.text);
                        streamed += event.text;
                    }
                }
                if (event.kind === 'message-completed') {
                    if (streamed && event.text.startsWith(streamed))
                        process.stdout.write(event.text.slice(streamed.length) + '\n');
                    else {
                        if (streamed)
                            process.stdout.write('\n');
                        console.log(event.text);
                    }
                    streamed = '';
                }
                if (event.kind === 'tool-started')
                    console.error(`Running ${event.tool}: ${event.brief}`);
                if (event.kind === 'error')
                    console.error(event.message);
                if (event.kind === 'dag-node' && options.verbose)
                    console.log(`${event.node.id}: ${event.node.status}`);
                if (event.kind === 'approval-requested') {
                    void (async () => {
                        const answer = rl ? await rl.question(`${event.tool}: ${event.brief} [y/a/N] `) : 'n';
                        session.submit({ kind: 'review', id: event.id, decision: answer === 'y' ? 'approved-once' : answer === 'a' ? 'approved-always' : 'denied' });
                    })().catch(() => session.submit({ kind: 'review', id: event.id, decision: 'denied' }));
                }
                if (event.kind === 'turn-ended') {
                    if (!event.ok)
                        process.exitCode = 1;
                    resolve({ ok: event.ok });
                }
            });
            session.submit(options.plan ? { kind: 'plan-task', text: prompt } : { kind: 'user-message', text: prompt, workspace, mode: 'agent' });
        });
    }
    finally {
        process.off('SIGINT', interrupt);
        rl?.close();
        await session.close();
    }
}
export const agentCommand = new Command('agent').alias('exec').description('Execute a task directly; use --plan to produce a plan without executing')
    .argument('[prompt...]').option('-p, --prompt <text>').option('--provider <provider>').option('--cwd <path>').option('-y, --yes').option('--ask-permission', 'Ask before each mutating tool action').option('--plan', 'Plan only, without executing').option('--full-access', 'Auto-approve tools and allow paths outside the workspace').option('-v, --verbose').option('--max-rounds <n>')
    .action(async (parts: string[], options: AgentOnceOptions) => {
    try {
        const prompt = options.prompt ?? parts.join(' ');
        if (!prompt.trim())
            throw new Error('Provide a task.');
        await runAgentOnce(prompt, options);
    }
    catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
});
