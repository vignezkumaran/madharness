import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { pruneFile } from '../ast/index.js';
import type { InterfaceContract } from '../ast/types.js';
import {
  estimateTokens,
  PROVIDER_COSTS,
  compareFileTokens,
  getAvailableBenchmarkFiles,
  type TokenComparisonResult,
} from '../utils/tokenComparison.js';

// ─── mad benchmark Command ──────────────────────────────────────────────────

export const benchmarkCommand = new Command('benchmark')
  .description('Benchmark MAD Harness AST pruner vs Claude Code full-file ingestion')
  .argument('[files...]', 'Python files or directories to benchmark', [])
  .option('--show-pruned', 'Display the pruned AST content for each file')
  .option('--json', 'Output results as JSON')
  .action(async (inputFiles: string[], options: { showPruned?: boolean; json?: boolean }) => {

    // ── Resolve target files (default to repository benchmark files) ────
    const filesToSearch = inputFiles.length > 0 ? inputFiles : getAvailableBenchmarkFiles();
    const pyFiles: string[] = [];

    for (const f of filesToSearch) {
      const resolved = path.resolve(f);
      if (!fs.existsSync(resolved)) {
        if (inputFiles.length > 0) {
          console.error(chalk.red(`✗ Not found: ${f}`));
        }
        continue;
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        collectPyFiles(resolved, pyFiles);
      } else if (resolved.endsWith('.py')) {
        pyFiles.push(resolved);
      }
    }

    if (pyFiles.length === 0) {
      console.error(chalk.red('\n✗ No Python files found to benchmark.\n'));
      process.exit(1);
    }

    // ── Run comparison on each file ────────────────────────────────────
    const results: TokenComparisonResult[] = [];

    if (!options.json) {
      console.log();
      console.log(chalk.bold.hex('#8B5CF6')('⚡ MAD HARNESS VS CLAUDE CODE — TOKEN & COST BENCHMARK'));
      console.log(chalk.hex('#A78BFA')('   Deterministic AST Pruning vs Full Context Ingestion · Executive Presentation'));
      console.log(chalk.hex('#4C1D95')('═'.repeat(74)));
      console.log();
    }

    for (const filePath of pyFiles) {
      try {
        const result = compareFileTokens(filePath);
        results.push(result);

        if (!options.json) {
          printFileResult(result, options.showPruned);
        }
      } catch (err) {
        console.error(chalk.red(`  ✗ Error processing ${filePath}: ${err instanceof Error ? err.message : err}`));
      }
    }

    // ── JSON Output ────────────────────────────────────────────────────
    if (options.json) {
      console.log(JSON.stringify({ results, summary: computeSummary(results) }, null, 2));
      return;
    }

    // ── Executive Presentation Summary ─────────────────────────────────
    if (results.length > 0) {
      printExecutiveSummary(results);
      printCostComparisonTable(results);
    }
  });


// ─── Display Helpers ────────────────────────────────────────────────────────

function printFileResult(result: TokenComparisonResult, showPruned?: boolean): void {
  const barWidth = 32;
  const filledWidth = Math.max(1, Math.round(((100 - result.savingsPercent) / 100) * barWidth));
  const emptyWidth = barWidth - filledWidth;
  const madBar = chalk.hex('#C4B5FD')('█'.repeat(filledWidth)) + chalk.hex('#3B1877')('░'.repeat(emptyWidth));
  const claudeBar = chalk.hex('#9CA3AF')('█'.repeat(barWidth));

  console.log(chalk.bold.white(`📄 ${result.relativePath} `) + chalk.dim(`(${result.originalLines} lines · ${result.originalBytes.toLocaleString()} bytes)`));
  console.log();

  // Head-to-Head Comparison Table
  console.log(
    chalk.hex('#A78BFA')('   Context Strategy'.padEnd(28)) +
    chalk.hex('#A78BFA')('Lines'.padStart(10)) +
    chalk.hex('#A78BFA')('Tokens'.padStart(14)) +
    chalk.hex('#A78BFA')('Cost (Sonnet)'.padStart(16)) +
    chalk.hex('#A78BFA')('Context Bloat'.padStart(16))
  );
  console.log(chalk.hex('#3B1877')('   ' + '─'.repeat(80)));

  // Claude Code Row
  console.log(
    chalk.white('   Claude Code (Raw)') +
    chalk.dim(''.padEnd(8)) +
    chalk.white(String(result.originalLines).padStart(10)) +
    chalk.white(result.originalTokens.toLocaleString().padStart(14)) +
    chalk.white(`$${(result.originalTokens * 0.000003).toFixed(4)}`.padStart(16)) +
    chalk.dim('Full Bodies'.padStart(16))
  );

  // MAD Harness Row
  console.log(
    chalk.hex('#8B5CF6').bold('   ⚡ MAD Harness (AST)') +
    chalk.dim(''.padEnd(5)) +
    chalk.hex('#C4B5FD').bold(String(result.prunedLines).padStart(10)) +
    chalk.hex('#C4B5FD').bold(result.prunedTokens.toLocaleString().padStart(14)) +
    chalk.hex('#C4B5FD').bold(`$${(result.prunedTokens * 0.000003).toFixed(4)}`.padStart(16)) +
    chalk.hex('#DDD6FE').bold('Contracts Only'.padStart(16))
  );

  console.log(chalk.hex('#3B1877')('   ' + '─'.repeat(80)));
  console.log(
    chalk.hex('#C4B5FD').bold(`   Net Reduction: ${result.savingsPercent}% Less Tokens`) +
    chalk.dim(` · Saved `) +
    chalk.hex('#DDD6FE').bold(`${result.savedTokens.toLocaleString()} tokens/turn`) +
    chalk.dim(` · `) +
    chalk.hex('#FFFFFF').bold(`${result.reductionMultiplier}x Cheaper`)
  );
  console.log();

  // Visual Gauge
  console.log(chalk.dim('   Claude Code: ') + `[${claudeBar}] ` + chalk.dim(`${result.originalTokens.toLocaleString()} tok (100%)`));
  console.log(chalk.hex('#8B5CF6')('   MAD Harness: ') + `[${madBar}] ` + chalk.hex('#C4B5FD').bold(`${result.prunedTokens.toLocaleString()} tok (${(100 - result.savingsPercent).toFixed(1)}%)`));
  console.log();

  // Structure extracted
  if (result.classes.length > 0) {
    console.log(chalk.dim('   Classes:   ') + chalk.hex('#C4B5FD')(result.classes.join(', ')));
  }
  if (result.functions.length > 0) {
    console.log(chalk.dim('   Functions: ') + chalk.hex('#A78BFA')(result.functions.join(', ')));
  }

  // Pruned content
  if (showPruned) {
    console.log();
    console.log(chalk.hex('#4C1D95')('   ┌─ Pruned AST Interface Contract ──────────────────────'));
    for (const line of result.prunedContent.split('\n')) {
      console.log(chalk.hex('#5B21B6')('   │ ') + chalk.dim(line));
    }
    console.log(chalk.hex('#4C1D95')('   └──────────────────────────────────────────────────────'));
  }

  console.log();
  console.log(chalk.hex('#3B1877')('─'.repeat(74)));
  console.log();
}


function computeSummary(results: TokenComparisonResult[]) {
  const totalOriginalTokens = results.reduce((sum, r) => sum + r.originalTokens, 0);
  const totalPrunedTokens = results.reduce((sum, r) => sum + r.prunedTokens, 0);
  const totalSavedTokens = totalOriginalTokens - totalPrunedTokens;
  const avgSavings = totalOriginalTokens > 0 ? (totalSavedTokens / totalOriginalTokens) * 100 : 0;
  const multiplier = totalPrunedTokens > 0 ? (totalOriginalTokens / totalPrunedTokens) : 1;
  const totalOriginalLines = results.reduce((sum, r) => sum + r.originalLines, 0);
  const totalPrunedLines = results.reduce((sum, r) => sum + r.prunedLines, 0);

  return {
    filesProcessed: results.length,
    totalOriginalTokens,
    totalPrunedTokens,
    totalSavedTokens,
    avgSavingsPercent: Math.round(avgSavings * 10) / 10,
    multiplier: Math.round(multiplier * 10) / 10,
    totalOriginalLines,
    totalPrunedLines,
  };
}


function printExecutiveSummary(results: TokenComparisonResult[]): void {
  const summary = computeSummary(results);

  console.log(chalk.bold.hex('#8B5CF6')('📊 EXECUTIVE PRESENTATION SUMMARY'));
  console.log(chalk.dim('   Benchmark results across active repository files'));
  console.log();

  console.log(chalk.white(`   Files Processed:           ${chalk.bold.hex('#FFFFFF')(String(summary.filesProcessed))}`));
  console.log(chalk.white(`   Claude Code Raw Context:   ${chalk.white(summary.totalOriginalTokens.toLocaleString())} tokens (${summary.totalOriginalLines} lines)`));
  console.log(chalk.white(`   MAD Harness AST Context:   ${chalk.hex('#C4B5FD').bold(summary.totalPrunedTokens.toLocaleString())} tokens (${summary.totalPrunedLines} lines)`));
  console.log(chalk.white(`   Net Tokens Eliminated:     ${chalk.hex('#DDD6FE').bold(summary.totalSavedTokens.toLocaleString())} tokens`));
  console.log(chalk.white(`   Average Token Reduction:   ${chalk.bold.hex('#C4B5FD')(`${summary.avgSavingsPercent}%`)} (${summary.multiplier}x Cheaper per Call) `));
  console.log();
}


function printCostComparisonTable(results: TokenComparisonResult[]): void {
  const summary = computeSummary(results);

  console.log(chalk.hex('#3B1877')('─'.repeat(74)));
  console.log();
  console.log(chalk.bold.hex('#8B5CF6')('💰 MULTI-MODEL COST SAVINGS MATRIX (Per-Call & Team Projections)'));
  console.log(chalk.dim('   Comparing full-context Claude Code vs MAD AST-pruned prompt payloads'));
  console.log();

  console.log(
    chalk.hex('#A78BFA')('   Provider / Model'.padEnd(24)) +
    chalk.hex('#A78BFA')('Claude Code'.padStart(14)) +
    chalk.hex('#A78BFA')('MAD Harness'.padStart(14)) +
    chalk.hex('#A78BFA')('Saved/Call'.padStart(14)) +
    chalk.hex('#A78BFA')('Annual Team ROI'.padStart(18))
  );
  console.log(chalk.hex('#3B1877')('   ' + '─'.repeat(80)));

  for (const [, provider] of Object.entries(PROVIDER_COSTS)) {
    const costBefore = (summary.totalOriginalTokens / 1_000_000) * provider.costPer1MInput;
    const costAfter = (summary.totalPrunedTokens / 1_000_000) * provider.costPer1MInput;
    const saved = costBefore - costAfter;
    // Assume team of developers making 1,000 calls/day over 250 work days
    const annualSavings = saved * 1000 * 250;

    console.log(
      chalk.white('   ' + provider.name.padEnd(21)) +
      chalk.white(`$${costBefore.toFixed(4)}`.padStart(14)) +
      chalk.hex('#C4B5FD').bold(`$${costAfter.toFixed(4)}`.padStart(14)) +
      chalk.hex('#DDD6FE').bold(`$${saved.toFixed(4)}`.padStart(14)) +
      chalk.bold.hex('#FFFFFF')(`+$${Math.round(annualSavings).toLocaleString()}/yr`.padStart(18))
    );
  }

  console.log();
  console.log(chalk.dim('   * Annual ROI assumes a 10-person dev team executing 1,000 AI coding turns / day'));
  console.log(chalk.hex('#C4B5FD')('   * MAD Harness prevents context degradation and attention dilution by removing method bodies'));
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
