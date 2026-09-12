import { Command } from 'commander';
import chalk from 'chalk';
import { sendToProvider } from '../providers/index.js';
import { providerManager } from '../providers/manager.js';
import type { ProviderName } from '../types.js';

export const askCommand = new Command('ask')
  .description('Directly ask the connected model a question (instant response)')
  .argument('<prompt...>', 'The prompt or task to send to the model')
  .option('-m, --model <provider>', 'Provider to use (groq, claude, gemini, codex)')
  .action(async (promptParts: string[], options: { model?: string }) => {
    const prompt = promptParts.join(' ');
    const provider = (options.model as ProviderName) || providerManager.getFirstConnectedProvider() || 'groq';

    if (!providerManager.hasApiKey(provider) && provider !== 'ollama') {
      console.error(chalk.white.bold(`\n✖ ${providerManager.getProviderDisplayName(provider)} is not authenticated.`));
      console.error(chalk.hex('#8B5CF6')(`  Run: mad chat and type ${provider}/login to connect your key.\n`));
      process.exit(1);
    }

    const t0 = Date.now();
    try {
      const response = await sendToProvider(provider, prompt);
      const latency = Date.now() - t0;

      console.log();
      console.log(
        chalk.hex('#8B5CF6').bold(`✦ ${providerManager.getProviderDisplayName(provider)} `) +
        chalk.dim(`(${response.model}) · ${latency}ms`)
      );
      console.log(chalk.hex('#4C1D95')('─'.repeat(50)));
      console.log(chalk.white(response.content));
      console.log();
    } catch (err) {
      console.error(chalk.white.bold(`\n✖ Error: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }
  });
