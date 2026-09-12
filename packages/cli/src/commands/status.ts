import { Command } from 'commander';
import chalk from 'chalk';
import { providerManager } from '../providers/manager.js';

// ─── Phase 1 Checklist ──────────────────────────────────────────────────────

interface ChecklistItem {
  name: string;
  done: boolean;
}

const PHASE1_CHECKLIST: ChecklistItem[] = [
  { name: 'CLI skeleton (Node.js + TypeScript)', done: true },
  { name: 'mad run command', done: true },
  { name: 'AST Pruner (TypeScript)', done: true },
  { name: 'DAG State Machine (TypeScript)', done: true },
  { name: 'Mock agents (Architect, Coder, Sandbox, Debugger)', done: true },
  { name: 'Basic config file', done: true },
  { name: 'mad status command', done: true },
  { name: 'Project structure complete', done: true },
];

// ─── mad status Command ─────────────────────────────────────────────────────

export const statusCommand = new Command('status')
  .description('Show MAD Harness status and Phase 1 progress')
  .action(() => {
    console.log(chalk.bold.hex('#8B5CF6')('\n⚡ MAD Harness Status (Claude Architecture)\n'));
    console.log(chalk.hex('#4C1D95')('─'.repeat(50)));

    // ── Provider Status ───────────────────────────────────────────────────
    console.log(chalk.bold.white('\n🔌 Model Providers in Harness:\n'));

    const providers = providerManager.getAllProviders();
    let connectedCount = 0;

    for (const [name, provider] of providers) {
      const isConnected = providerManager.hasApiKey(name);
      if (isConnected) connectedCount++;

      const statusIcon = isConnected
        ? chalk.hex('#C4B5FD')('●')
        : chalk.dim('○');
      const statusText = isConnected
        ? chalk.hex('#C4B5FD').bold('Active & Listed') + chalk.dim(` (${providerManager.getMaskedKey(name)})`)
        : chalk.dim('Not Listed (no API key)');

      console.log(
        `  ${statusIcon} ${chalk.bold(provider.config.displayName.padEnd(22))} ` +
        `${chalk.dim(`(${provider.config.model})`)} — ${statusText}`
      );
    }

    console.log();
    if (connectedCount === 0) {
      console.log(chalk.hex('#DDD6FE')('  ⚠ No models are listed in this harness yet.'));
      console.log(chalk.dim('    Run ') + chalk.hex('#8B5CF6')('mad chat') + chalk.dim(' and type ') + chalk.hex('#8B5CF6')('groq/login') + chalk.dim(' to paste your key.'));
    } else {
      console.log(chalk.hex('#C4B5FD')(`  ✓ ${connectedCount} model(s) authenticated and ready for chat/DAG.`));
    }

    // ── Phase 1 Checklist ─────────────────────────────────────────────────
    console.log();
    console.log(chalk.hex('#4C1D95')('─'.repeat(50)));
    console.log(chalk.bold.white('\n📊 Phase 1 Checklist:\n'));

    let doneCount = 0;
    for (const item of PHASE1_CHECKLIST) {
      if (item.done) {
        doneCount++;
        console.log(chalk.hex('#C4B5FD')(`   ✓ ${item.name}`));
      } else {
        console.log(chalk.dim(`   ○ ${item.name}`));
      }
    }

    const totalCount = PHASE1_CHECKLIST.length;
    const progressPercent = Math.round((doneCount / totalCount) * 100);
    const barFilled = Math.round((doneCount / totalCount) * 20);
    const barEmpty = 20 - barFilled;
    const progressBar = chalk.hex('#8B5CF6')('■'.repeat(barFilled)) + chalk.hex('#4C1D95')('░'.repeat(barEmpty));

    console.log();
    console.log(`   Progress: ${progressBar} ${chalk.bold.hex('#C4B5FD')(`${progressPercent}%`)} (${doneCount}/${totalCount})`);

    // ── Quick Commands ────────────────────────────────────────────────────
    console.log();
    console.log(chalk.hex('#4C1D95')('─'.repeat(50)));
    console.log();
    console.log(chalk.dim('  Quick commands:'));
    console.log(
      chalk.hex('#8B5CF6')('  npm run chat      ') +
      chalk.dim('  — Start interactive Claude chat (type groq/login to paste key)')
    );
    console.log(
      chalk.hex('#8B5CF6')('  mad run <file.py> ') +
      chalk.dim('  — Run the agent pipeline')
    );
    console.log(
      chalk.hex('#8B5CF6')('  mad benchmark     ') +
      chalk.dim('  — Benchmark AST token reduction')
    );
    console.log();
  });
