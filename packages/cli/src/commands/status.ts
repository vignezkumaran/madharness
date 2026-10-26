import { Command } from 'commander';
import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { providerManager } from '../providers/manager.js';

const execFileAsync = promisify(execFile);

export const statusCommand = new Command('status')
  .description('Show harness, workspace, and provider status')
  .action(async () => {
    console.log();
    console.log(chalk.bold.hex('#9370db')('◈ MAD') + chalk.white(' — terminal multi-agent harness'));
    console.log(chalk.dim('  supervisor + parallel workers · distill · mesh bus · provider fabric'));
    console.log(chalk.hex('#2a1a3a')('─'.repeat(64)));

    let branch = '(not a git repo)';
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: process.cwd(), timeout: 5000 });
      branch = stdout.trim() || '(detached)';
    } catch {
      // not a repo
    }

    console.log();
    console.log(chalk.bold.white('Workspace'));
    console.log(`  ${chalk.dim('cwd')}    ${process.cwd()}`);
    console.log(`  ${chalk.dim('branch')} ${branch}`);

    console.log();
    console.log(chalk.bold.white('Providers'));
    let connected = 0;
    let localAgents = 0;
    for (const [name, provider] of providerManager.getVisibleProviders()) {
      const local = providerManager.isLocalAgentName(name);
      const configured = providerManager.isConfigured(name);
      if (local && configured) localAgents++;
      else if (name !== 'ollama' && configured) connected++;
      const icon = configured
        ? chalk.hex('#9370db')('●')
        : name === 'ollama'
          ? chalk.hex('#d8b4fe')('○')
          : chalk.dim('○');
      const label = local
        ? configured ? chalk.dim('local CLI · detected') : chalk.dim('local CLI · missing')
        : provider.config.apiKey
          ? chalk.dim(providerManager.getMaskedKey(name))
          : name === 'ollama'
            ? chalk.dim('local · http://localhost:11434')
            : chalk.dim('not connected');
      console.log(`  ${icon} ${provider.config.displayName.padEnd(24)} ${chalk.dim(provider.config.model.padEnd(38))} ${label}`);
    }

    console.log();
    if (connected === 0 && localAgents === 0) {
      console.log(chalk.hex('#d8b4fe')('  No provider connected.'));
      console.log(chalk.dim('  Run: ') + chalk.hex('#9370db')('mad auth') + chalk.dim(' and paste any provider key (auto-detected).'));
    } else {
      const parts = [
        connected ? `${connected} hosted provider(s)` : '',
        localAgents ? `${localAgents} local agent(s) detected` : '',
        'ollama available if running',
      ].filter(Boolean);
      console.log(chalk.hex('#9370db')(`  ${parts.join(' · ')}.`));
    }

    console.log();
    console.log(chalk.hex('#2a1a3a')('─'.repeat(64)));
    console.log(chalk.dim('  mad                     interactive agent'));
    console.log(chalk.dim('  mad "fix the tests"     one-shot agent'));
    console.log(chalk.dim('  mad ask "..."           direct model answer'));
    console.log(chalk.dim('  mad pipeline file.py    deterministic AST pipeline'));
    console.log(chalk.dim('  mad benchmark           token reduction report'));
    console.log();
  });
