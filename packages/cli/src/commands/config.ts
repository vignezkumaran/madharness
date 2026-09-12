import { Command } from 'commander';
import chalk from 'chalk';
import { providerManager } from '../providers/manager.js';
import type { ProviderName } from '../types.js';

export const configCommand = new Command('config')
  .description('Configure MAD Harness providers')
  .argument('[provider]', 'Provider to configure')
  .option('-k, --key <key>', 'API key')
  .action((provider?: string, options?: { key?: string }) => {
    if (provider && options?.key) {
      providerManager.setApiKey(provider as ProviderName, options.key);
      console.log(chalk.green(`\n✅ API key set for ${provider}\n`));
    } else {
      console.log(chalk.bold.cyan('\n⚡ MAD Harness Configuration\n'));
      console.log(chalk.dim('Usage:'));
      console.log(chalk.cyan('  mad config <provider> --key <api-key>'));
      console.log(chalk.dim('\nSupported providers:'));
      console.log(chalk.cyan('  claude, codex, groq, ollama, gemini'));
      console.log(chalk.dim('\nExample:'));
      console.log(chalk.cyan('  mad config claude --key sk-ant-...'));
      console.log(chalk.cyan('  mad config groq --key gsk_...'));
      console.log();
    }
  });
