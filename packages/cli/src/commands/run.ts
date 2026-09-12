import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { pruneFile } from '../ast/index.js';
import { DAGEngine, mockAgentExecutor, realAgentExecutor } from '../dag/index.js';
import type { DAGEvent } from '../dag/types.js';
import { defaultConfig } from '../config/mad.config.js';
import { providerManager } from '../providers/manager.js';

// ─── mad run Command ────────────────────────────────────────────────────────
//
// Usage:
//   $ mad run ./src/feature.py              Run full pipeline
//   $ mad run ./src/feature.py --dry-run    AST prune only
//   $ mad run ./src/feature.py --verbose    Show agent output details
//   $ mad run ./src/feature.py --retries 5  Override circuit breaker
// ─────────────────────────────────────────────────────────────────────────────

export const runCommand = new Command('run')
  .description('Run the MAD agent pipeline on a Python file')
  .argument('<file>', 'Python file to process')
  .option('--dry-run', 'Only run AST pruning, skip pipeline execution')
  .option('--verbose', 'Show detailed agent output')
  .option('--retries <n>', 'Override max retries per node (default: 3)', '3')
  .action(async (file: string, options: { dryRun?: boolean; verbose?: boolean; retries?: string }) => {
    const filePath = path.resolve(file);
    const maxRetries = parseInt(options.retries ?? '3', 10);

    // ── Validate input ────────────────────────────────────────────────────
    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`\n✗ File not found: ${filePath}\n`));
      process.exit(1);
    }

    if (!filePath.endsWith('.py')) {
      console.error(chalk.red(`\n✗ Expected a .py file, got: ${path.basename(filePath)}\n`));
      process.exit(1);
    }

    // ── Header ────────────────────────────────────────────────────────────
    console.log();
    console.log(chalk.bold.cyan('⚡ MAD Harness — Running Pipeline'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log();
    console.log(chalk.white(`📂 Target: ${chalk.cyan(file)}`));
    console.log();

    // ── AST Pruning ──────────────────────────────────────────────────────
    try {
      const contract = pruneFile(filePath, defaultConfig.ast);

      console.log(chalk.bold.white('🔍 AST Pruning:'));
      console.log(chalk.white(`   Original:  ${chalk.yellow(String(contract.originalLines))} lines`));
      console.log(chalk.white(`   Pruned:    ${chalk.green(String(contract.prunedLines))} lines`));
      console.log(chalk.white(`   Savings:   ${chalk.green(contract.tokenSavingsPercent.toFixed(1) + '%')} token reduction`));

      if (contract.classes.length > 0) {
        console.log(chalk.white(`   Classes:   ${chalk.cyan(contract.classes.join(', '))}`));
      }
      if (contract.functions.length > 0) {
        console.log(chalk.white(`   Functions: ${chalk.cyan(contract.functions.join(', '))}`));
      }
      if (contract.imports.length > 0) {
        console.log(chalk.white(`   Imports:   ${chalk.dim(String(contract.imports.length) + ' statements')}`));
      }

      if (options.verbose) {
        console.log();
        console.log(chalk.dim('── Pruned Content ──────────────────────────────'));
        console.log(chalk.dim(contract.prunedContent));
        console.log(chalk.dim('────────────────────────────────────────────────'));
      }

      // ── Dry run exit ──────────────────────────────────────────────────
      if (options.dryRun) {
        console.log();
        console.log(chalk.dim('─'.repeat(50)));
        console.log();
        console.log(chalk.yellow('⏭  Dry run complete — pipeline execution skipped'));
        console.log();
        return;
      }

      // ── Pipeline Execution ────────────────────────────────────────────
      console.log();
      console.log(chalk.dim('─'.repeat(50)));
      console.log();
      console.log(chalk.bold.white('🏗️  Pipeline Execution:'));
      console.log();

      // Override retries if specified
      const nodes = defaultConfig.pipeline.nodes.map(node => ({
        ...node,
        maxRetries,
      }));

      const engine = new DAGEngine(nodes);

      // ── Event handler for real-time progress ──────────────────────────
      engine.on((event: DAGEvent) => {
        switch (event.type) {
          case 'node_start':
            process.stdout.write(
              chalk.white(`   ● ${padRight(capitalize(event.role!), 12)} `) +
              chalk.yellow('running...')
            );
            break;

          case 'node_retry':
            process.stdout.write('\r' + ' '.repeat(60) + '\r');
            process.stdout.write(
              chalk.white(`   ◎ ${padRight(capitalize(event.role!), 12)} `) +
              chalk.yellow(`retrying (attempt ${(event.data?.retryCount ?? 0) + 1})...`)
            );
            break;

          case 'node_complete': {
            const elapsed = event.data?.duration ?? 0;
            process.stdout.write('\r' + ' '.repeat(60) + '\r');
            console.log(
              chalk.white(`   ● ${padRight(capitalize(event.role!), 12)} `) +
              chalk.green('█'.repeat(20)) + ' ' +
              chalk.green.bold('PASSED') + '  ' +
              chalk.dim(`(${(elapsed / 1000).toFixed(1)}s)`)
            );
            if (options.verbose && event.data?.output) {
              for (const line of event.data.output.split('\n')) {
                console.log(chalk.dim(`     ${line}`));
              }
            }
            break;
          }

          case 'node_failed': {
            process.stdout.write('\r' + ' '.repeat(60) + '\r');
            console.log(
              chalk.white(`   ● ${padRight(capitalize(event.role!), 12)} `) +
              chalk.red('█'.repeat(20)) + ' ' +
              chalk.red.bold('FAILED') + '  ' +
              chalk.dim(event.data?.error ?? '')
            );
            break;
          }

          case 'dag_complete':
          case 'dag_failed':
            break; // Handled after execute()
        }
      });

      // Check for connected real AI model
      const connectedProvider = providerManager.getFirstConnectedProvider();
      const executor = connectedProvider ? realAgentExecutor : mockAgentExecutor;

      if (connectedProvider) {
        console.log(chalk.white(`   ⚡ Engine: ${chalk.green.bold('Live AI')} via ${chalk.cyan.bold(providerManager.getProviderDisplayName(connectedProvider))}`));
      } else {
        console.log(chalk.white(`   ⚡ Engine: ${chalk.yellow('Simulation Mode')} (type ${chalk.cyan('groq/login')} in chat to use real AI)`));
      }
      console.log();

      // ── Execute the pipeline ───────────────────────────────────────────
      const result = await engine.execute(contract.prunedContent, executor);

      console.log();
      console.log(chalk.dim('─'.repeat(50)));
      console.log();

      if (result.state === 'COMPLETED') {
        console.log(chalk.green.bold('✅ Pipeline completed successfully!'));
        console.log(chalk.white(`   Total time: ${chalk.cyan((result.totalDuration / 1000).toFixed(1) + 's')}`));
        console.log(chalk.white(`   Retries:    ${chalk.cyan(String(result.totalRetries))}`));
      } else {
        console.log(chalk.red.bold('❌ Pipeline failed!'));
        console.log(chalk.red(`   ${result.error}`));
        console.log(chalk.white(`   Total time: ${chalk.cyan((result.totalDuration / 1000).toFixed(1) + 's')}`));
        console.log(chalk.white(`   Retries:    ${chalk.cyan(String(result.totalRetries))}`));
      }
      console.log();

    } catch (error) {
      console.error(chalk.red(`\n✗ Error: ${error instanceof Error ? error.message : String(error)}\n`));
      process.exit(1);
    }
  });

// ─── Helpers ────────────────────────────────────────────────────────────────

function padRight(str: string, len: number): string {
  return str.padEnd(len);
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
