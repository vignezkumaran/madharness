#!/usr/bin/env node
import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { chatCommand } from './commands/chat.js';
import { statusCommand } from './commands/status.js';
import { configCommand } from './commands/config.js';
import { authCommand } from './commands/auth.js';
import { runCommand } from './commands/run.js';
import { benchmarkCommand } from './commands/benchmark.js';
import { askCommand } from './commands/ask.js';
import { agentCommand, runAgentOnce } from './commands/agent.js';
import { App } from './components/App.js';

async function launchInteractive(): Promise<void> {
  const { waitUntilExit } = render(React.createElement(App));
  await waitUntilExit();
}

const program = new Command()
  .name('mad')
  .description(
    'MAD — terminal multi-agent coding harness\n' +
    'Supervisor + parallel workers · Distill · Mesh Bus · Provider Fabric\n\n' +
    'Run with no arguments for the interactive agent. Pass a prompt for one-shot mode.'
  )
  .version('0.3.0')
  .enablePositionalOptions()
  .argument('[prompt...]', 'Task to run in one-shot mode')
  .option('-p, --prompt <text>', 'Task to run in one-shot mode')
  .option('--provider <provider>', 'Provider for one-shot mode')
  .option('--cwd <path>', 'Workspace for one-shot mode', process.cwd())
  .option('-y, --yes', 'Auto-approve writes and shell commands (one-shot)')
  .option('-v, --verbose', 'Verbose one-shot output')
  .action(async (promptParts: string[], options: {
    prompt?: string;
    provider?: string;
    cwd?: string;
    yes?: boolean;
    verbose?: boolean;
  }) => {
    const prompt = (options.prompt ?? promptParts.join(' ')).trim();

    if (!prompt) {
      await launchInteractive();
      return;
    }

    try {
      await runAgentOnce(prompt, options);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program.addCommand(agentCommand);
program.addCommand(chatCommand);
program.addCommand(askCommand);
program.addCommand(authCommand);
program.addCommand(statusCommand);
program.addCommand(configCommand);
program.addCommand(runCommand);
program.addCommand(benchmarkCommand);

program.parse();
