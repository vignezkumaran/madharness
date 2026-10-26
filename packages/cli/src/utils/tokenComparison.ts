import * as fs from 'fs';
import * as path from 'path';
import { pruneFile } from '../ast/index.js';
import type { InterfaceContract } from '../ast/types.js';

// ─── Token Estimation ───────────────────────────────────────────────────────
// Uses the standard BPE tokenizer approximation (~4 characters per token for code).
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ─── Provider Pricing Reference ($ per 1M tokens) ───────────────────────────
export interface ProviderPricing {
  name: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  providerFamily: 'Anthropic' | 'OpenAI' | 'Google' | 'Meta/Groq' | 'DeepSeek';
}

export const PROVIDER_COSTS: Record<string, ProviderPricing> = {
  'claude-3.5-sonnet': {
    name: 'Claude 3.5 Sonnet',
    costPer1MInput: 3.00,
    costPer1MOutput: 15.00,
    providerFamily: 'Anthropic',
  },
  'claude-3-opus': {
    name: 'Claude 3 Opus',
    costPer1MInput: 15.00,
    costPer1MOutput: 75.00,
    providerFamily: 'Anthropic',
  },
  'gpt-4o': {
    name: 'GPT-4o',
    costPer1MInput: 2.50,
    costPer1MOutput: 10.00,
    providerFamily: 'OpenAI',
  },
  'gpt-4-turbo': {
    name: 'GPT-4 Turbo',
    costPer1MInput: 10.00,
    costPer1MOutput: 30.00,
    providerFamily: 'OpenAI',
  },
  'gemini-2.0-pro': {
    name: 'Gemini 2.0 Pro',
    costPer1MInput: 1.25,
    costPer1MOutput: 5.00,
    providerFamily: 'Google',
  },
  'llama-3.3-70b': {
    name: 'Groq Llama 3.3 70B',
    costPer1MInput: 0.59,
    costPer1MOutput: 0.79,
    providerFamily: 'Meta/Groq',
  },
  'deepseek-v3': {
    name: 'DeepSeek V3',
    costPer1MInput: 0.27,
    costPer1MOutput: 1.10,
    providerFamily: 'DeepSeek',
  },
};

// ─── Comparison Result Interface ────────────────────────────────────────────
export interface ModelCostComparison {
  name: string;
  family: string;
  claudeCodeCost: number;       // Raw full-context cost ($ / call)
  madCost: number;              // AST-pruned cost ($ / call)
  savedCost: number;            // Net dollar savings ($ / call)
  savingsPercent: number;       // % savings
  annualTeamSavings: number;    // Projected annual savings at 1,000 calls/day
}

export interface TokenComparisonResult {
  file: string;
  relativePath: string;
  originalLines: number;
  prunedLines: number;
  lineReductionPercent: number;
  originalBytes: number;
  prunedBytes: number;
  originalTokens: number;        // Claude Code baseline
  prunedTokens: number;          // MAD Harness AST
  savedTokens: number;
  savingsPercent: number;
  reductionMultiplier: number;  // e.g. 14.5x
  classes: string[];
  functions: string[];
  imports: string[];
  prunedContent: string;
  modelCosts: ModelCostComparison[];
}

export interface BenchmarkSummary {
  filesProcessed: number;
  totalOriginalTokens: number;
  totalPrunedTokens: number;
  totalSavedTokens: number;
  avgSavingsPercent: number;
  avgReductionMultiplier: number;
  totalOriginalLines: number;
  totalPrunedLines: number;
  modelCosts: ModelCostComparison[];
  annualTeamSavingsSonnet: number;
  annualTeamSavingsOpus: number;
}

// ─── Compare a Single File ──────────────────────────────────────────────────
export function compareFileTokens(filePath: string): TokenComparisonResult {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const originalContent = fs.readFileSync(resolved, 'utf-8');
  const contract: InterfaceContract = pruneFile(resolved);

  const originalLines = contract.originalLines;
  const prunedLines = contract.prunedLines;
  const lineReductionPercent = originalLines > 0 
    ? Math.round(((originalLines - prunedLines) / originalLines) * 1000) / 10 
    : 0;

  const originalBytes = originalContent.length;
  const prunedBytes = contract.prunedContent.length;

  const originalTokens = estimateTokens(originalContent);
  const prunedTokens = estimateTokens(contract.prunedContent);
  const savedTokens = Math.max(0, originalTokens - prunedTokens);
  const savingsPercent = originalTokens > 0 
    ? Math.round(((originalTokens - prunedTokens) / originalTokens) * 1000) / 10 
    : 0;

  const reductionMultiplier = prunedTokens > 0
    ? Math.round((originalTokens / prunedTokens) * 10) / 10
    : 1;

  const modelCosts: ModelCostComparison[] = Object.values(PROVIDER_COSTS).map(provider => {
    const claudeCodeCost = (originalTokens / 1_000_000) * provider.costPer1MInput;
    const madCost = (prunedTokens / 1_000_000) * provider.costPer1MInput;
    const savedCost = claudeCodeCost - madCost;
    const pct = claudeCodeCost > 0 ? (savedCost / claudeCodeCost) * 100 : 0;
    // Assume 1,000 developer calls / day * 250 working days / year
    const annualTeamSavings = savedCost * 1000 * 250;

    return {
      name: provider.name,
      family: provider.providerFamily,
      claudeCodeCost,
      madCost,
      savedCost,
      savingsPercent: Math.round(pct * 10) / 10,
      annualTeamSavings: Math.round(annualTeamSavings),
    };
  });

  return {
    file: resolved,
    relativePath: path.relative(process.cwd(), resolved),
    originalLines,
    prunedLines,
    lineReductionPercent,
    originalBytes,
    prunedBytes,
    originalTokens,
    prunedTokens,
    savedTokens,
    savingsPercent,
    reductionMultiplier,
    classes: contract.classes,
    functions: contract.functions,
    imports: contract.imports,
    prunedContent: contract.prunedContent,
    modelCosts,
  };
}

// ─── Find Available Benchmark Files ─────────────────────────────────────────
export function getAvailableBenchmarkFiles(): string[] {
  const candidates = [
    'benchmark_large.py',
    'test_sample.py',
    'src/feature.py',
    'feature.py',
  ];

  const found: string[] = [];
  for (const c of candidates) {
    const p = path.resolve(process.cwd(), c);
    if (fs.existsSync(p)) {
      found.push(c);
    }
  }

  return found.length > 0 ? found : ['benchmark_large.py'];
}

// ─── Aggregate Benchmark Summary ────────────────────────────────────────────
export function computeBenchmarkSummary(results: TokenComparisonResult[]): BenchmarkSummary {
  const filesProcessed = results.length;
  const totalOriginalTokens = results.reduce((sum, r) => sum + r.originalTokens, 0);
  const totalPrunedTokens = results.reduce((sum, r) => sum + r.prunedTokens, 0);
  const totalSavedTokens = totalOriginalTokens - totalPrunedTokens;
  const avgSavingsPercent = totalOriginalTokens > 0
    ? Math.round(((totalSavedTokens / totalOriginalTokens) * 1000)) / 10
    : 0;

  const avgReductionMultiplier = totalPrunedTokens > 0
    ? Math.round((totalOriginalTokens / totalPrunedTokens) * 10) / 10
    : 1;

  const totalOriginalLines = results.reduce((sum, r) => sum + r.originalLines, 0);
  const totalPrunedLines = results.reduce((sum, r) => sum + r.prunedLines, 0);

  const modelCosts: ModelCostComparison[] = Object.values(PROVIDER_COSTS).map(provider => {
    const claudeCodeCost = (totalOriginalTokens / 1_000_000) * provider.costPer1MInput;
    const madCost = (totalPrunedTokens / 1_000_000) * provider.costPer1MInput;
    const savedCost = claudeCodeCost - madCost;
    const pct = claudeCodeCost > 0 ? (savedCost / claudeCodeCost) * 100 : 0;
    const annualTeamSavings = savedCost * 1000 * 250;

    return {
      name: provider.name,
      family: provider.providerFamily,
      claudeCodeCost,
      madCost,
      savedCost,
      savingsPercent: Math.round(pct * 10) / 10,
      annualTeamSavings: Math.round(annualTeamSavings),
    };
  });

  const sonnet = modelCosts.find(m => m.name.includes('Sonnet'));
  const opus = modelCosts.find(m => m.name.includes('Opus'));

  return {
    filesProcessed,
    totalOriginalTokens,
    totalPrunedTokens,
    totalSavedTokens,
    avgSavingsPercent,
    avgReductionMultiplier,
    totalOriginalLines,
    totalPrunedLines,
    modelCosts,
    annualTeamSavingsSonnet: sonnet ? sonnet.annualTeamSavings : 0,
    annualTeamSavingsOpus: opus ? opus.annualTeamSavings : 0,
  };
}
