import { Command } from 'commander';
import chalk from 'chalk';
import { complete } from '../providers/complete.js';
import { providerManager } from '../providers/manager.js';
import type { ProviderName } from '../types.js';

export const askCommand = new Command('ask')
  .description('Ask the active provider directly (no agent tools)')
  .argument('<prompt...>', 'The prompt or task to send to the model')
  .option('-m, --model <provider>', 'Provider to use (opencode, claude, gemini, codex, ollama)')
  .action(async (promptParts: string[], options: { model?: string }) => {
    const prompt = promptParts.join(' ');
    const provider = (options.model
      ? providerManager.resolveProviderName(options.model)
      : providerManager.getFirstConnectedProvider()) as ProviderName | null;

    if (!provider) {
      console.error(chalk.red('\n✖ No model connected. Run: mad auth and paste any provider key.\n'));
      process.exitCode = 1;
      return;
    }

    if (providerManager.isProviderDisabled(provider)) {
      console.error(chalk.red(`\n✖ ${providerManager.getProviderDisplayName(provider)} is disabled.\n`));
      process.exitCode = 1;
      return;
    }

    const started = Date.now();
    try {
      const response = await complete(provider, [
        {
          role: 'system',
          content: 'You are MAD, a concise senior software engineer in a terminal. Answer directly and accurately.',
        },
        { role: 'user', content: prompt },
      ], { maxTokens: 4096, temperature: 0.2 });

      const latency = Date.now() - started;

      console.log();
      console.log(
        chalk.hex('#2DD4BF').bold(`◈ ${providerManager.getProviderDisplayName(provider)} `)
        + chalk.dim(`(${response.model}) · ${latency}ms`)
      );
      console.log(chalk.white(response.content));
      console.log();
      console.log(chalk.hex('#134E4A')('─'.repeat(52)));
      console.log(
        chalk.hex('#2DD4BF').bold('tokens ')
        + chalk.hex('#FBBF24')(response.tokens.toLocaleString())
        + chalk.dim(` · ${latency}ms · ${response.model}`)
      );
      console.log();
    } catch (err) {
      console.error(chalk.red(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;
    }
  });
