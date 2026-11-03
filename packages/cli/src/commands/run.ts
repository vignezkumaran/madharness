import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { distillSource } from '../agent/distill.js';
import { runAgentOnce } from './agent.js';
export const runCommand = new Command('run').alias('pipeline').description('Distill a source file, then execute improvements').argument('[file]', 'Source file', 'benchmark_large.py').option('--dry-run').option('--verbose').option('--retries <n>', 'Maximum verification rounds', '2')
    .action(async (file: string, options: {
    dryRun?: boolean;
    verbose?: boolean;
    retries?: string;
}) => {
    try {
        const absolute = path.resolve(file);
        const content = fs.readFileSync(absolute, 'utf8');
        const result = distillSource(absolute, content, process.cwd());
        console.log(`${result.relativePath}: ~${result.originalTokens} → ~${result.distilledTokens} estimated tokens (${result.savingsPercent}% saved)`);
        if (options.verbose)
            console.log(result);
        if (!options.dryRun)
            await runAgentOnce(`Review and improve ${absolute}, preserving behavior.`, { verbose: options.verbose, maxRounds: options.retries });
    }
    catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
});
