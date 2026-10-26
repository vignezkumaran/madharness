import { Command } from 'commander';
import chalk from 'chalk';
import { providerManager } from '../providers/manager.js';
import type { ProviderName } from '../types.js';

export const configCommand = new Command('config')
  .description('Configure MAD Harness providers')
  .argument('[provider]', 'Provider to configure')
  .option('-k, --key <key>', 'API key')
  .option('--enable', 'Enable a disabled provider')
  .option('--disable', 'Disable a provider')
  .action((provider?: string, options?: { key?: string; enable?: boolean; disable?: boolean }) => {
    if (provider && (options?.enable || options?.disable)) {
      const name = provider as ProviderName;
      if (!providerManager.getProvider(name)) {
        console.error(chalk.red(`\n✖ Unknown provider: ${provider}\n`));
        process.exitCode = 1;
        return;
      }
      providerManager.setProviderDisabled(name, Boolean(options.disable));
      console.log(chalk.green(`\n✅ ${providerManager.getProviderDisplayName(name)} ${options.disable ? 'disabled' : 'enabled'}\n`));
      return;
    }

    if (provider && options?.key) {
      const name = provider as ProviderName;
      if (providerManager.isProviderDisabled(name)) {
        console.error(chalk.red(`\n✖ ${providerManager.getProviderDisplayName(name)} is disabled.\n`));
        process.exitCode = 1;
        return;
      }
      providerManager.setApiKey(name, options.key);
      console.log(chalk.green(`\n✅ API key set for ${provider}\n`));
    } else {
      console.log(chalk.bold.cyan('\nMAD provider configuration\n'));
      console.log(chalk.dim('Usage:'));
      console.log(chalk.cyan('  mad auth                  # paste any key, auto-detected'));
      console.log(chalk.cyan('  mad auth <provider>       # force a provider'));
      console.log(chalk.cyan('  mad config <provider> --key <api-key>'));
      console.log(chalk.cyan('  mad config <provider> --enable|--disable'));
      console.log(chalk.dim('\nSupported providers:'));
      console.log(chalk.cyan('  opencode, claude, codex, ollama, gemini, pi'));
      console.log(chalk.dim('\nExample:'));
      console.log(chalk.cyan('  mad config claude --key sk-ant-...'));
      console.log(chalk.cyan('  mad config groq --enable'));
      console.log();
    }
  });
