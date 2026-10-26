import { Command } from 'commander';
import chalk from 'chalk';
import { providerManager } from '../providers/manager.js';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    process.stdout.write(question);

    if (!stdin.isTTY) {
      let value = '';
      stdin.setEncoding('utf8');
      stdin.resume();
      stdin.on('data', (chunk) => {
        value += chunk;
      });
      stdin.on('end', () => resolve(value.trim()));
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const cleanup = () => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.off('data', onData);
    };

    const onData = (char: string) => {
      if (char === '\r' || char === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(value.trim());
        return;
      }
      if (char === '\u0003') {
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      }
      if (char === '\u007f' || char === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      value += char;
      process.stdout.write('*');
    };

    stdin.on('data', onData);
  });
}

export const authCommand = new Command('auth')
  .alias('login')
  .description('Connect a model provider API key (auto-detects the provider)')
  .argument('[providerOrKey]', 'Provider name, or paste an API key to auto-detect')
  .argument('[key]', 'API key (omit to paste interactively)')
  .option('-k, --key <key>', 'API key')
  .action(async (providerOrKey: string | undefined, keyArg: string | undefined, options: { key?: string }) => {
    let provider = providerOrKey ? providerManager.resolveProviderName(providerOrKey) : null;
    let key = options.key ?? keyArg;
    let detected = false;

    if (providerOrKey && !provider) {
      if (keyArg) {
        console.error(chalk.red(`\n✖ Unknown provider: ${providerOrKey}`));
        console.error(chalk.dim('  Use: opencode, claude, gemini, codex, pi, or ollama\n'));
        process.exitCode = 1;
        return;
      }

      const fromKey = providerManager.detectProviderFromKey(providerOrKey);
      if (!fromKey) {
        console.error(chalk.red(`\n✖ Could not detect a provider from: ${providerOrKey}`));
        console.error(chalk.dim('  Recognized keys: gsk_ (Groq) · sk-ant- (Anthropic) · sk- (OpenAI) · AIza (Gemini)\n'));
        console.error(chalk.dim('  Or name the provider: mad auth groq\n'));
        process.exitCode = 1;
        return;
      }
      provider = fromKey;
      key = providerOrKey;
      detected = true;
    }

    if (!provider) {
      if (!key) {
        key = await promptHidden('Paste any provider API key: ');
      }
      if (!key.trim()) {
        console.error(chalk.red('\n✖ No key provided.\n'));
        process.exitCode = 1;
        return;
      }
      const fromKey = providerManager.detectProviderFromKey(key);
      if (!fromKey) {
        console.error(chalk.red('\n✖ Could not detect a provider from that key.'));
        console.error(chalk.dim('  Run: mad auth groq  (or claude, gemini, codex)\n'));
        process.exitCode = 1;
        return;
      }
      provider = fromKey;
      detected = true;
    }

    if (providerManager.isProviderDisabled(provider)) {
      console.error(chalk.red(`\n✖ ${providerManager.getProviderDisplayName(provider)} is disabled.\n`));
      process.exitCode = 1;
      return;
    }

    if (provider === 'ollama') {
      console.log(chalk.dim('\nOllama runs locally. Start it with `ollama serve` and connect at http://localhost:11434.\n'));
      return;
    }

    if (!key) {
      key = await promptHidden(`Paste ${providerManager.getProviderDisplayName(provider)} API key: `);
    }

    if (!key.trim()) {
      console.error(chalk.red('\n✖ No key provided.\n'));
      process.exitCode = 1;
      return;
    }

    providerManager.setApiKey(provider, key.trim());
    const prefix = detected ? 'Detected and connected' : 'Connected';
    console.log(chalk.hex('#2DD4BF')(`\n✓ ${prefix} ${providerManager.getProviderDisplayName(provider)}`));
    console.log(chalk.dim(`  key: ${providerManager.getMaskedKey(provider)}`));
    console.log(chalk.dim('  Run: mad\n'));
  });
