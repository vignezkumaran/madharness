import type { AgentRole, AgentResult } from './types.js';
import type { ProviderName } from '../types.js';
import { sendToProvider } from '../providers/index.js';
import { providerManager } from '../providers/manager.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Architect mock outputs */
const ARCHITECT_OUTPUTS = [
  'Generated implementation plan with 3 components:\n  1. Data validation layer\n  2. Business logic processor\n  3. Output formatter\nDependency graph resolved. No circular dependencies detected.',
  'Architecture analysis complete:\n  - Identified 4 modules requiring changes\n  - Suggested pattern: Strategy + Factory\n  - Estimated complexity: Medium',
  'Implementation plan created:\n  - Break into 2 sub-tasks\n  - Apply separation of concerns\n  - Use dependency injection for testability',
];

/** Coder mock outputs */
const CODER_OUTPUTS = [
  'Generated 247 lines across 3 files:\n  - processor.py (142 lines)\n  - validator.py (68 lines)\n  - formatter.py (37 lines)\nAll imports resolved. Type annotations complete.',
  'Code generation complete:\n  - Modified 2 existing files\n  - Created 1 new module\n  - Added 15 unit tests\n  - All type hints verified',
];

/** Sandbox mock outputs */
const SANDBOX_OUTPUTS = [
  'Test execution results:\n  ✓ 12 tests passed\n  ✓ No lint errors (ruff)\n  ✓ Type-check clean (mypy)\n  ✓ Coverage: 94.2%',
  'Sandbox validation:\n  ✓ 8 unit tests passed\n  ✓ 3 integration tests passed\n  ✓ No security warnings\n  ✓ Memory usage within limits',
];

/** Debugger mock outputs */
const DEBUGGER_OUTPUTS = [
  'Debug analysis complete:\n  - No issues found\n  - Code quality score: A+\n  - All edge cases handled\n  - Performance: within acceptable bounds',
  'Fix summary:\n  - Applied 2 minor optimizations\n  - Added null-safety checks\n  - Improved error messages\n  - All tests still passing',
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Mock agent executor for offline or simulated test runs.
 * Simulates Mesh Bus chatter: each peer reads context.bus and appends.
 */
export async function mockAgentExecutor(
  role: AgentRole,
  input: string,
  context: Record<string, string>
): Promise<AgentResult> {
  let delay: number;
  let passProbability: number;
  let output: string;

  switch (role) {
    case 'distill':
      delay = randomDelay(300, 700);
      passProbability = 1.0;
      output = `BUS◈ published contract (${Math.min(input.length, 2000)} chars in → ~7% kept): signatures + imports + types only. Peers subscribe from here — nobody re-ingests raw.`;
      break;
    case 'architect':
      delay = randomDelay(800, 1500);
      passProbability = 1.0;
      output = pickRandom(ARCHITECT_OUTPUTS);
      break;
    case 'coder':
      delay = randomDelay(1000, 2500);
      passProbability = 0.9;
      output = pickRandom(CODER_OUTPUTS);
      break;
    case 'sandbox':
      delay = randomDelay(500, 1200);
      passProbability = 0.85;
      output = pickRandom(SANDBOX_OUTPUTS);
      break;
    case 'verifier':
      delay = randomDelay(600, 1000);
      passProbability = 1.0;
      output = 'BUS◈ verifier converged: contract adherence 100% · 2 handoff fixes applied · 0 raw re-ingests · mesh consensus reached.';
      break;
    case 'debugger':
      delay = randomDelay(600, 1000);
      passProbability = 1.0;
      output = pickRandom(DEBUGGER_OUTPUTS);
      break;
    default:
      delay = 100;
      passProbability = 0;
      output = `Unknown agent role: ${role}`;
  }

  await sleep(delay);

  const passed = Math.random() < passProbability;

  return {
    role,
    state: passed ? 'PASSED' : 'FAILED',
    output: passed ? output : `Error during ${role} execution: simulated failure for testing`,
    duration: delay,
    retryCount: 0,
    error: passed ? undefined : `Simulated ${role} failure — will retry`,
  };
}

/**
 * Real LLM-backed agent executor.
 * Dispatches actual tasks to the connected model provider (e.g. Groq, Claude, Gemini).
 */
export async function realAgentExecutor(
  role: AgentRole,
  input: string,
  context: Record<string, string>,
  providerOverride?: ProviderName
): Promise<AgentResult> {
  const provider = providerOverride || providerManager.getFirstConnectedProvider();

  if (!provider) {
    return mockAgentExecutor(role, input, context);
  }

  const startTime = Date.now();
  let systemPrompt = '';
  let prompt = '';

  // Keep inputs compact to stay well within API token limits
  const cleanInput = input.length > 2000 ? input.slice(0, 2000) + '\n...[truncated]' : input;
  const cleanCoder = (context['coder'] || cleanInput).slice(0, 2000);
  const cleanArch = (context['architect'] || 'Standard architecture').slice(0, 1500);
  const cleanSandbox = (context['sandbox'] || 'All basic checks passed').slice(0, 1500);

  switch (role) {
    case 'distill':
      systemPrompt = 'You are the Distiller peer in the MAD mesh. Compress input to signatures/imports/types only. Output ONLY the contract.';
      prompt = `Distill this to a minimal interface contract:\n\n${cleanInput}`;
      break;

    case 'architect':
      systemPrompt = 'You are the Architect peer in the MAD mesh. Read the distilled contract from the bus, post a plan + open questions for coder/verifier to critique.';
      prompt = `Here is the distilled contract from the bus:\n\n${cleanInput}\n\nPost plan + 3 open questions (concise, no raw re-ingest).`;
      break;

    case 'coder':
      systemPrompt = 'You are the Coder peer in the MAD mesh. Build ONLY to the contract + architect plan on the bus. Flag any contract gaps as handoffs.';
      prompt = `Architecture plan:\n${cleanArch}\n\nDistilled contract:\n${cleanInput}\n\nGenerate scoped implementation + handoff flags.`;
      break;

    case 'verifier':
      systemPrompt = 'You are the Verifier peer in the MAD mesh. Converge: approve or request precise handoff fixes. Never ask for raw re-ingest.';
      prompt = `Contract:\n${cleanInput}\n\nCoder:\n${cleanCoder}\n\nCritiques:\n${cleanSandbox}\n\nVerdict: approve or handoff fixes.`;
      break;

    case 'sandbox':
      systemPrompt = 'You are the Sandbox peer in the MAD mesh. Verify syntax/deps/safety of the coder post on the bus.';
      prompt = `Review this bus-posted implementation:\n\n${cleanCoder}\n\nReport: lint, types, tests.`;
      break;

    case 'debugger':
      systemPrompt = 'You are the Debugger peer in the MAD mesh. Final audit on bus state only.';
      prompt = `Sandbox report:\n${cleanSandbox}\n\nImplementation:\n${cleanCoder}\n\nFinal audit: production-ready?`;
      break;
  }

  try {
    const fullPrompt = `${systemPrompt}\n\n${prompt}`;
    const response = await sendToProvider(provider, fullPrompt);
    const duration = Date.now() - startTime;

    return {
      role,
      state: 'PASSED',
      output: response.content,
      duration,
      retryCount: 0,
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    return {
      role,
      state: 'FAILED',
      output: `Error during ${role} execution: ${err instanceof Error ? err.message : String(err)}`,
      duration,
      retryCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
