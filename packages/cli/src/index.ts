#!/usr/bin/env node
import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { statusCommand } from './commands/status.js';
import { configCommand } from './commands/config.js';
import { runCommand } from './commands/run.js';
import { benchmarkCommand } from './commands/benchmark.js';
import { askCommand } from './commands/ask.js';

const program = new Command()
  .name('mad')
  .description('MAD Harness — Multi-Agent Deterministic Harness')
  .version('0.1.0');

program.addCommand(chatCommand);
program.addCommand(askCommand);
program.addCommand(statusCommand);
program.addCommand(configCommand);
program.addCommand(runCommand);
program.addCommand(benchmarkCommand);

// Default to showing help if no command specified
program.action(() => {
  program.help();
});

program.parse();
