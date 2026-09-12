import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { pruneFile } from '../ast/index.js';
import type { InterfaceContract } from '../ast/types.js';

// ─── Token Estimation ───────────────────────────────────────────────────────
//
// Uses the standard GPT/Claude approximation: ~4 characters per token.
// This is close to the actual BPE tokenizer for English code.
// ─────────────────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  // Average ~4 chars per token for code (conservative estimate)
  return Math.ceil(text.length / 4);
}

/** Cost per 1M input tokens (approximate, in USD) */
const PROVIDER_COSTS: Record<string, { name: string; costPer1MInput: number; costPer1MOutput: number }> = {
  'claude-3.5-sonnet': { name: 'Claude 3.5 Sonnet', costPer1MInput: 3.00, costPer1MOutput: 15.00 },
  'claude-3-opus':     { name: 'Claude 3 Opus',     costPer1MInput: 15.00, costPer1MOutput: 75.00 },
  'gpt-4o':            { name: 'GPT-4o',            costPer1MInput: 2.50, costPer1MOutput: 10.00 },
  'gpt-4-turbo':       { name: 'GPT-4 Turbo',       costPer1MInput: 10.00, costPer1MOutput: 30.00 },
  'gemini-2.0-pro':    { name: 'Gemini 2.0 Pro',    costPer1MInput: 1.25, costPer1MOutput: 5.00 },
  'llama-3.3-70b':     { name: 'Groq Llama 3.3',    costPer1MInput: 0.59, costPer1MOutput: 0.79 },
  'deepseek-v3':       { name: 'DeepSeek V3',       costPer1MInput: 0.27, costPer1MOutput: 1.10 },
};

// ─── mad benchmark Command ──────────────────────────────────────────────────

export const benchmarkCommand = new Command('benchmark')
  .description('Benchmark AST pruner token reduction on Python files')
  .argument('<files...>', 'Python files or directories to benchmark')
  .option('--show-pruned', 'Display the pruned content for each file')
  .option('--json', 'Output results as JSON')
  .action(async (files: string[], options: { showPruned?: boolean; json?: boolean }) => {

    // ── Resolve all .py files ──────────────────────────────────────────
    const pyFiles: string[] = [];
    for (const f of files) {
      const resolved = path.resolve(f);
      if (!fs.existsSync(resolved)) {
        console.error(chalk.red(`✗ Not found: ${f}`));
        continue;
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        // Recurse for .py files
        collectPyFiles(resolved, pyFiles);
      } else if (resolved.endsWith('.py')) {
        pyFiles.push(resolved);
      } else {
        console.error(chalk.yellow(`⚠ Skipping non-.py file: ${f}`));
      }
    }

    if (pyFiles.length === 0) {
      console.error(chalk.red('\n✗ No Python files found to benchmark.\n'));
      process.exit(1);
    }

    // ── Run pruner on each file ────────────────────────────────────────
    const results: BenchmarkResult[] = [];

    if (!options.json) {
      console.log();
      console.log(chalk.bold.cyan('⚡ MAD Harness — Token Reduction Benchmark'));
      console.log(chalk.dim('═'.repeat(65)));
      console.log();
    }

    for (const filePath of pyFiles) {
      try {
        const originalContent = fs.readFileSync(filePath, 'utf-8');
        const contract = pruneFile(filePath);

        const originalTokens = estimateTokens(originalContent);
        const prunedTokens = estimateTokens(contract.prunedContent);
        const savedTokens = originalTokens - prunedTokens;
        const savingsPercent = originalTokens > 0 ? (savedTokens / originalTokens) * 100 : 0;

        const result: BenchmarkResult = {
          file: path.relative(process.cwd(), filePath),
          originalLines: contract.originalLines,
          prunedLines: contract.prunedLines,
          originalTokens,
          prunedTokens,
          savedTokens,
          savingsPercent,
          originalBytes: originalContent.length,
          prunedBytes: contract.prunedContent.length,
          classes: contract.classes,
          functions: contract.functions,
          imports: contract.imports,
        };
        results.push(result);

        if (!options.json) {
          printFileResult(result, options.showPruned ? contract : undefined);
        }
      } catch (err) {
        console.error(chalk.red(`  ✗ Error processing ${filePath}: ${err instanceof Error ? err.message : err}`));
      }
    }

    // ── Summary ─────────────────────────────────────────────────────────
    if (options.json) {
      console.log(JSON.stringify({ results, summary: computeSummary(results) }, null, 2));
      return;
    }

    if (results.length > 0) {
      printSummary(results);
      printCostComparison(results);
    }
  });


// ─── Types ──────────────────────────────────────────────────────────────────

interface BenchmarkResult {
  file: string;
  originalLines: number;
  prunedLines: number;
  originalTokens: number;
  prunedTokens: number;
  savedTokens: number;
  savingsPercent: number;
  originalBytes: number;
  prunedBytes: number;
  classes: string[];
  functions: string[];
  imports: string[];
}

// ─── Display Helpers ────────────────────────────────────────────────────────

function printFileResult(result: BenchmarkResult, contract?: InterfaceContract): void {
  const barWidth = 30;
  const filledWidth = Math.round((result.savingsPercent / 100) * barWidth);
  const emptyWidth = barWidth - filledWidth;
  const bar = chalk.green('█'.repeat(filledWidth)) + chalk.dim('░'.repeat(emptyWidth));

  console.log(chalk.bold.white(`📄 ${result.file}`));
  console.log();

  // Token comparison
  console.log(chalk.white('   Tokens:'));
  console.log(chalk.white(`     Before:  ${chalk.red(result.originalTokens.toLocaleString().padStart(8))} tokens`));
  console.log(chalk.white(`     After:   ${chalk.green(result.prunedTokens.toLocaleString().padStart(8))} tokens`));
  console.log(chalk.white(`     Saved:   ${chalk.cyan(result.savedTokens.toLocaleString().padStart(8))} tokens`));
  console.log();

  // Lines comparison
  console.log(chalk.white('   Lines:'));
  console.log(chalk.white(`     Before:  ${chalk.red(String(result.originalLines).padStart(8))} lines`));
  console.log(chalk.white(`     After:   ${chalk.green(String(result.prunedLines).padStart(8))} lines`));
  console.log();

  // Visual bar
  console.log(chalk.white(`   Reduction: ${bar} ${chalk.bold.green(result.savingsPercent.toFixed(1) + '%')}`));
  console.log();

  // Structure found
  if (result.classes.length > 0) {
    console.log(chalk.white(`   Classes:   ${chalk.cyan(result.classes.join(', '))}`));
  }
  if (result.functions.length > 0) {
    console.log(chalk.white(`   Functions: ${chalk.cyan(result.functions.join(', '))}`));
  }

  // Pruned content
  if (contract) {
    console.log();
    console.log(chalk.dim('   ┌─ Pruned Content ──────────────────────────────────────'));
    for (const line of contract.prunedContent.split('\n')) {
      console.log(chalk.dim(`   │ ${line}`));
    }
    console.log(chalk.dim('   └──────────────────────────────────────────────────────'));
  }

  console.log();
  console.log(chalk.dim('─'.repeat(65)));
  console.log();
}


function computeSummary(results: BenchmarkResult[]) {
  const totalOriginalTokens = results.reduce((sum, r) => sum + r.originalTokens, 0);
  const totalPrunedTokens = results.reduce((sum, r) => sum + r.prunedTokens, 0);
  const totalSavedTokens = totalOriginalTokens - totalPrunedTokens;
  const avgSavings = totalOriginalTokens > 0 ? (totalSavedTokens / totalOriginalTokens) * 100 : 0;
  const totalOriginalLines = results.reduce((sum, r) => sum + r.originalLines, 0);
  const totalPrunedLines = results.reduce((sum, r) => sum + r.prunedLines, 0);

  return {
    filesProcessed: results.length,
    totalOriginalTokens,
    totalPrunedTokens,
    totalSavedTokens,
    avgSavingsPercent: Math.round(avgSavings * 10) / 10,
    totalOriginalLines,
    totalPrunedLines,
  };
}


function printSummary(results: BenchmarkResult[]): void {
  const summary = computeSummary(results);

  console.log(chalk.bold.cyan('📊 BENCHMARK SUMMARY'));
  console.log();
  console.log(chalk.white(`   Files processed:     ${chalk.bold(String(summary.filesProcessed))}`));
  console.log();
  console.log(chalk.bold.white('   Token Comparison:'));
  console.log(chalk.white(`     Without pruning:   ${chalk.red(summary.totalOriginalTokens.toLocaleString())} tokens`));
  console.log(chalk.white(`     With MAD pruning:  ${chalk.green(summary.totalPrunedTokens.toLocaleString())} tokens`));
  console.log(chalk.white(`     Tokens saved:      ${chalk.cyan(summary.totalSavedTokens.toLocaleString())} tokens`));
  console.log(chalk.white(`     Average reduction: ${chalk.bold.green(summary.avgSavingsPercent + '%')}`));
  console.log();
  console.log(chalk.bold.white('   Line Comparison:'));
  console.log(chalk.white(`     Without pruning:   ${chalk.red(summary.totalOriginalLines.toLocaleString())} lines`));
  console.log(chalk.white(`     With MAD pruning:  ${chalk.green(summary.totalPrunedLines.toLocaleString())} lines`));
  console.log();
}


function printCostComparison(results: BenchmarkResult[]): void {
  const summary = computeSummary(results);

  console.log(chalk.dim('─'.repeat(65)));
  console.log();
  console.log(chalk.bold.cyan('💰 COST SAVINGS PER API CALL (Input Tokens)'));
  console.log();
  console.log(
    chalk.dim('   ' +
      'Provider'.padEnd(22) +
      'Without'.padStart(12) +
      'With MAD'.padStart(12) +
      'Saved'.padStart(12) +
      'Savings %'.padStart(12)
    )
  );
  console.log(chalk.dim('   ' + '─'.repeat(58)));

  for (const [, provider] of Object.entries(PROVIDER_COSTS)) {
    const costBefore = (summary.totalOriginalTokens / 1_000_000) * provider.costPer1MInput;
    const costAfter = (summary.totalPrunedTokens / 1_000_000) * provider.costPer1MInput;
    const saved = costBefore - costAfter;
    const pct = costBefore > 0 ? (saved / costBefore) * 100 : 0;

    console.log(
      chalk.white('   ' +
        provider.name.padEnd(22) +
        chalk.red(`$${costBefore.toFixed(4)}`.padStart(12)) +
        chalk.green(`$${costAfter.toFixed(4)}`.padStart(12)) +
        chalk.cyan(`$${saved.toFixed(4)}`.padStart(12)) +
        chalk.bold.green(`${pct.toFixed(1)}%`.padStart(12))
      )
    );
  }

  console.log();
  console.log(chalk.dim('   * Costs are per-call estimates based on current provider pricing'));
  console.log(chalk.dim('   * At 1000 calls/day, multiply savings by 1000 for daily impact'));
  console.log();
}


// ─── File Collection ────────────────────────────────────────────────────────

function collectPyFiles(dir: string, results: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__pycache__') {
      collectPyFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      results.push(fullPath);
    }
  }
}
