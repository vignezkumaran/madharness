import { Command } from 'commander';
import * as readline from 'readline/promises';
import * as path from 'path';
import chalk from 'chalk';
import { providerManager } from '../providers/manager.js';
import { runAgent } from '../agent/supervisor.js';
import type {
  AgentRunResult,
  ApprovalDecision,
  ApprovalRequest,
  HarnessEvent,
  PlanTask,
} from '../agent/types.js';

export interface AgentOnceOptions {
  prompt?: string;
  provider?: string;
  cwd?: string;
  yes?: boolean;
  verbose?: boolean;
  maxRounds?: string;
}

function statusLine(text: string): void {
  process.stdout.write(`${chalk.dim('·')} ${chalk.dim(text)}\n`);
}

function printTask(task: PlanTask, icon: string, color: (text: string) => string): void {
  const provider = task.provider ? chalk.dim(` · ${task.provider}`) : '';
  const tokens = task.tokens ? chalk.hex('#FBBF24')(` · ${task.tokens}t`) : '';
  process.stdout.write(`${color(icon)} ${chalk.bold(task.role)} ${chalk.white(task.title)}${provider}${tokens}\n`);
}

function createEventPrinter(verbose: boolean): (event: HarnessEvent) => void {
  const taskStates = new Map<string, string>();
  let tokens = 0;

  return (event) => {
    switch (event.type) {
      case 'status':
        statusLine(event.text);
        break;

      case 'plan':
        process.stdout.write('\n');
        process.stdout.write(`${chalk.bold.hex('#2DD4BF')('◈ PLAN')} ${chalk.white(event.plan.summary)}\n`);
        for (const task of event.plan.tasks) {
          const writes = task.writes ? chalk.hex('#FBBF24')(' · writes') : '';
          process.stdout.write(`  ${chalk.dim('○')} ${chalk.hex('#5EEAD4')(task.role.padEnd(10))} ${task.title}${writes}\n`);
        }
        process.stdout.write(`  ${chalk.dim('acceptance:')} ${chalk.dim(event.plan.acceptance.join('; '))}\n\n`);
        break;

      case 'agent': {
        const previous = taskStates.get(event.task.id);
        if (event.task.status === 'running' && previous !== 'running') {
          printTask(event.task, '▶', chalk.hex('#2DD4BF'));
          taskStates.set(event.task.id, 'running');
        } else if (event.task.status === 'done' && previous !== 'done') {
          printTask(event.task, '✓', chalk.hex('#2DD4BF'));
          if (event.task.summary) {
            const lines = event.task.summary.split('\n').slice(0, 4);
            for (const line of lines) process.stdout.write(`  ${chalk.dim(' ')} ${chalk.dim(line)}\n`);
          }
          taskStates.set(event.task.id, 'done');
        } else if (event.task.status === 'failed' && previous !== 'failed') {
          printTask(event.task, '✗', chalk.red);
          if (event.task.error) {
            const lines = event.task.error.split('\n');
            process.stdout.write(`    ${chalk.red(lines[0])}\n`);
            if (verbose) {
              for (const line of lines.slice(1, 12)) process.stdout.write(`    ${chalk.dim(line)}\n`);
            }
          }
          taskStates.set(event.task.id, 'failed');
        }
        break;
      }

      case 'thinking':
        if (verbose) {
          process.stdout.write(`  ${chalk.dim('…')} ${chalk.dim(event.text.replace(/\s+/g, ' ').slice(0, 120))}\n`);
        }
        break;

      case 'tool':
        if (event.status === 'start') {
          process.stdout.write(`  ${chalk.hex('#5EEAD4')('●')} ${chalk.white(event.summary)}\n`);
        } else if (event.status === 'error') {
          const lines = (event.detail ?? '').split('\n').slice(0, 4);
          process.stdout.write(`    ${chalk.red('↳ error')} ${chalk.dim(lines[0] ?? '')}\n`);
          if (verbose) {
            for (const line of lines.slice(1)) process.stdout.write(`      ${chalk.red(line)}\n`);
          }
        } else if (verbose) {
          const first = (event.detail ?? '').split('\n')[0] ?? 'ok';
          process.stdout.write(`    ${chalk.dim(`↳ ${first.slice(0, 120)}`)}\n`);
        }
        break;

      case 'bus':
        if (event.entry.kind === 'handoff' || event.entry.kind === 'critique') {
          process.stdout.write(`  ${chalk.hex('#FBBF24')('⇄')} ${chalk.hex('#FBBF24')(event.entry.kind)} ${chalk.dim(event.entry.content.split('\n')[0] ?? '')}\n`);
        }
        break;

      case 'tokens':
        tokens += event.tokens;
        if (verbose) process.stdout.write(`  ${chalk.dim(`· ${event.provider} +${event.tokens}t (${tokens}t)`)}\n`);
        break;

      case 'diff':
        if (verbose) {
          process.stdout.write(`\n${chalk.dim(event.text.slice(0, 8_000))}\n\n`);
        }
        break;

      case 'assistant':
        process.stdout.write(`\n${event.content}\n\n`);
        break;

      case 'error':
        process.stdout.write(`${chalk.red('✖')} ${chalk.red(event.message)}\n`);
        break;
    }
  };
}

async function createApproval(options: AgentOnceOptions): Promise<{
  approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  close: () => void;
}> {
  if (!process.stdin.isTTY || options.yes) {
    return {
      approve: async (request) => {
        if (options.yes) {
          process.stdout.write(`${chalk.hex('#FBBF24')('⚠ auto-approved')} ${request.summary}\n`);
          return 'always';
        }
        process.stdout.write(`${chalk.red('✖ denied (non-interactive)')} ${request.summary}\n`);
        return 'deny';
      },
      close: () => undefined,
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return {
    approve: async (request) => {
      process.stdout.write(`\n${chalk.hex('#FBBF24').bold('⚠ Approval required')} ${chalk.bold(request.tool)}\n`);
      process.stdout.write(`${chalk.white(request.summary)}\n`);
      if (request.detail) {
        for (const line of request.detail.split('\n').slice(0, 14)) {
          process.stdout.write(`${chalk.dim(`  ${line}`)}\n`);
        }
      }

      while (true) {
        const answer = (await rl.question(`${chalk.hex('#2DD4BF')('[y]')} once  ${chalk.hex('#FBBF24')('[a]')} always  ${chalk.dim('[n]')} deny › `))
          .trim()
          .toLowerCase();
        if (answer === 'y' || answer === 'yes') return 'once';
        if (answer === 'a' || answer === 'always') return 'always';
        if (answer === 'n' || answer === 'no' || answer === '') return 'deny';
        process.stdout.write(`${chalk.dim('Answer y, a, or n.')}\n`);
      }
    },
    close: () => rl.close(),
  };
}

export async function runAgentOnce(prompt: string, options: AgentOnceOptions = {}): Promise<AgentRunResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const requested = options.provider ? providerManager.resolveProviderName(options.provider) : null;

  if (options.provider && !requested) {
    throw new Error(`Unknown provider: ${options.provider}. Use opencode, groq, claude, gemini, codex, or ollama.`);
  }

  if (requested && providerManager.isProviderDisabled(requested)) {
    throw new Error(`${providerManager.getProviderDisplayName(requested)} is disabled.`);
  }

  const provider = requested && providerManager.isProviderAvailable(requested)
    ? requested
    : providerManager.getFirstConnectedProvider();

  if (!provider) {
    throw new Error([
      'No model connected.',
      'Run: mad auth   and paste any provider API key (auto-detected).',
    ].join('\n'));
  }

  process.stdout.write('\n');
  if (requested && requested !== provider) {
    process.stdout.write(
      `${chalk.hex('#FBBF24')('⚠')} ${chalk.dim(`${providerManager.getProviderDisplayName(requested)} is not connected; using ${providerManager.getProviderDisplayName(provider)}`)}.\n`
    );
  }
  process.stdout.write(`${chalk.bold.hex('#2DD4BF')('◈ MAD')} ${chalk.white('supervisor + parallel workers')}\n`);
  process.stdout.write(`${chalk.dim(`⌂ ${cwd} · model ${providerManager.getProviderDisplayName(provider)}`)}\n`);
  process.stdout.write(`${chalk.dim('─'.repeat(72))}\n\n`);
  process.stdout.write(`${chalk.hex('#2DD4BF')('❯')} ${chalk.bold(prompt)}\n\n`);

  const gate = await createApproval(options);
  const controller = new AbortController();
  let interrupted = false;

  const onSigint = () => {
    if (interrupted) {
      gate.close();
      process.exit(130);
    }
    interrupted = true;
    process.stdout.write(`\n${chalk.hex('#FBBF24')('Cancelling…')} press Ctrl+C again to force quit.\n`);
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  try {
    const result = await runAgent({
      prompt,
      cwd,
      provider,
      approve: gate.approve,
      onEvent: createEventPrinter(Boolean(options.verbose)),
      signal: controller.signal,
      maxRounds: options.maxRounds ? Math.max(1, Number(options.maxRounds) || 1) : 2,
    });

    process.stdout.write(`${chalk.dim('─'.repeat(72))}\n`);
    const label = result.ok ? chalk.hex('#2DD4BF')('◈ done') : chalk.red('✖ incomplete');
    process.stdout.write(
      `${label} ${chalk.dim('·')} ${chalk.hex('#FBBF24')(`${result.tokens.toLocaleString()} tok`)} ${chalk.dim('·')} ${chalk.dim(`${(result.duration / 1000).toFixed(1)}s`)}`
      + `${result.changedFiles.length ? ` ${chalk.dim('·')} ${chalk.white(`${result.changedFiles.length} file(s) changed`)}` : ''}\n`
    );

    if (!result.ok) process.exitCode = 1;
    return result;
  } finally {
    process.off('SIGINT', onSigint);
    gate.close();
  }
}

export const agentCommand = new Command('agent')
  .alias('exec')
  .description('Run a one-shot supervisor + parallel worker mesh (non-interactive)')
  .argument('[prompt...]', 'Task to run')
  .option('-p, --prompt <text>', 'Task to run')
  .option('--provider <provider>', 'Provider to use')
  .option('--cwd <path>', 'Workspace directory', process.cwd())
  .option('-y, --yes', 'Auto-approve writes and shell commands')
  .option('-v, --verbose', 'Show thoughts, tool output, and diffs')
  .option('--max-rounds <n>', 'Verification/fix rounds', '2')
  .action(async (promptParts: string[], options: AgentOnceOptions) => {
    const prompt = (options.prompt ?? promptParts.join(' ')).trim();

    if (!prompt) {
      console.error(chalk.red('\n✖ Provide a prompt. Example: mad agent "fix the failing tests"\n'));
      process.exitCode = 1;
      return;
    }

    try {
      await runAgentOnce(prompt, options);
    } catch (err) {
      console.error(chalk.red(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;
    }
  });
