import type { ProviderName } from '../types.js';
import { completeWithFallback } from '../providers/complete.js';
import { collectRepoContext } from './context.js';
import { MeshBus } from './bus.js';
import { runWorker } from './worker.js';
import { Toolbelt } from './tools.js';
import { providerManager } from '../providers/manager.js';
import { simpleGit } from 'simple-git';
import type {
  AgentPlan,
  ApproveFn,
  HarnessEvent,
  PlanTask,
  WorkerResult,
} from './types.js';

export interface DagProgress {
  stage: number;
  total: number;
  label: string;
  detail?: string;
  failed?: boolean;
}

export interface DagRunOptions {
  prompt: string;
  cwd: string;
  provider: ProviderName;
  approve: ApproveFn;
  onProgress: (progress: DagProgress) => void;
  onEvent?: (event: HarnessEvent) => void;
  signal?: AbortSignal;
  allowAlways?: Set<string>;
}

export interface DagRunResult {
  ok: boolean;
  summary: string;
  tokens: number;
  changedFiles: string[];
  diff?: string;
  error?: string;
}

const TOTAL = 4;

function task(
  id: string,
  role: PlanTask['role'],
  title: string,
  body: string,
  writes: boolean
): PlanTask {
  return {
    id,
    role,
    title,
    task: body,
    dependsOn: [],
    writes,
    status: 'pending',
  };
}

function plan(summary: string, tasks: PlanTask[]): AgentPlan {
  return {
    mode: 'plan',
    summary,
    tasks,
    acceptance: [
      'The requested change is implemented in the existing code style.',
      'Relevant tests, typecheck, or build complete without new failures.',
      'No unrelated files are modified.',
    ],
  };
}

function lastLines(output: string, count = 3): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-count);
  return lines.length > 0
    ? lines.map((line) => line.slice(0, 240)).join('\n')
    : '(no output)';
}

function collectFiles(...results: WorkerResult[]): string[] {
  const files = new Set<string>();
  for (const result of results) {
    for (const file of result.changedFiles) files.add(file);
  }
  return Array.from(files);
}

async function readDiff(cwd: string): Promise<string | undefined> {
  try {
    const diff = await simpleGit({ baseDir: cwd }).diff();
    const trimmed = diff.trim();
    return trimmed ? trimmed.slice(0, 4_000) : undefined;
  } catch {
    return undefined;
  }
}

export async function runDag(options: DagRunOptions): Promise<DagRunResult> {
  const {
    prompt,
    cwd,
    provider,
    approve,
    onProgress,
    onEvent,
    signal,
    allowAlways,
  } = options;

  if (providerManager.isLocalAgentName(provider)) {
    throw new Error('The DAG pipeline needs a cloud or Ollama provider. Local CLI agents are for direct chat.');
  }

  let tokens = 0;
  const bus = new MeshBus(onEvent);
  const toolbelt = new Toolbelt(cwd, approve, allowAlways ?? []);

  onProgress({
    stage: 1,
    total: TOTAL,
    label: 'Architect',
    detail: 'Pruning AST and entering workspace context...',
  });

  const context = await collectRepoContext(cwd, prompt);
  if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

  onProgress({
    stage: 1,
    total: TOTAL,
    label: 'Architect',
    detail: 'Drafting implementation plan...',
  });
  bus.post('dag-architect', 'architect', 'note', 'drafting implementation plan');

  const architect = await completeWithFallback(provider, [
    {
      role: 'system',
      content: [
        'You are the ARCHITECT in MAD, a terminal coding harness.',
        'Read the distilled workspace context and produce a concrete implementation plan.',
        'Name exact files, functions, and the order of edits. Call out risks and the checks to run.',
        'Do not write code files. Keep the plan under 400 words.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `TASK:\n${prompt}\n\nAST-PRUNED WORKSPACE CONTEXT:\n${context.text}`,
    },
  ], {
    signal,
    maxTokens: 1_400,
    temperature: 0.15,
  });
  tokens += architect.tokens;
  if (!architect.content.trim()) throw new Error('Architect returned an empty plan.');
  bus.post('dag-architect', 'architect', 'plan', architect.content);

  const coderTask = task(
    'dag-coder',
    'coder',
    'Implement the architect plan',
    [
      `TASK:\n${prompt}`,
      '',
      `ARCHITECT PLAN:\n${architect.content}`,
      '',
      context.testCommand ? `TEST COMMAND: ${context.testCommand}` : 'TEST COMMAND: none detected',
      '',
      'Implement the plan with surgical edits. Read before editing. Do not commit.',
    ].join('\n'),
    true
  );

  onProgress({
    stage: 2,
    total: TOTAL,
    label: 'Coder',
    detail: 'Implementing the plan...',
  });

  const coder = await runWorker({
    agentId: 'dag-coder',
    task: { ...coderTask, status: 'running' },
    plan: plan(prompt, [coderTask]),
    provider,
    workspaceContext: context.text,
    bus,
    toolbelt,
    signal,
    maxSteps: 18,
    onEvent: (event) => {
      onEvent?.(event);
      if (event.type === 'tool' && event.status === 'start') {
        onProgress({
          stage: 2,
          total: TOTAL,
          label: 'Coder',
          detail: event.summary,
        });
      }
    },
  });
  tokens += coder.tokens;

  if (!coder.ok) {
    return {
      ok: false,
      summary: 'Coder failed before sandbox testing.',
      tokens,
      changedFiles: collectFiles(coder),
      error: coder.error ?? coder.summary,
    };
  }

  const runSandbox = async (): Promise<{ ok: boolean; output: string }> => {
    if (!context.testCommand) {
      return { ok: true, output: 'No test command detected; sandbox skipped.' };
    }

    onProgress({
      stage: 3,
      total: TOTAL,
      label: 'Sandbox Testing',
      detail: context.testCommand,
    });
    bus.post('dag-sandbox', 'verifier', 'note', `running: ${context.testCommand}`);

    const result = await toolbelt.run(
      'run_shell',
      { command: context.testCommand, timeoutMs: 240_000 },
      {
        agentId: 'dag-sandbox',
        role: 'verifier',
        signal,
        postToBus: (kind, content) => bus.post('dag-sandbox', 'verifier', kind, content),
      }
    );
    bus.post(
      'dag-sandbox',
      'verifier',
      result.ok ? 'result' : 'critique',
      `Sandbox ${result.ok ? 'passed' : 'failed'}: ${context.testCommand}\n${lastLines(result.output, 6)}`
    );
    return { ok: result.ok, output: result.output };
  };

  let sandbox = await runSandbox();
  let debuggerSummary = '';
  let failures = sandbox.ok ? 0 : 1;
  let attempts = 0;

  while (!sandbox.ok && failures < 3) {
    attempts++;
    const failure = lastLines(sandbox.output, 3);

    onProgress({
      stage: 4,
      total: TOTAL,
      label: 'Debugger',
      detail: `Repair ${attempts}/2 · ${failure.split('\n').slice(-1)[0] ?? 'fixing failure'}`,
    });

    const debugTask = task(
      'dag-debugger',
      'debugger',
      `Fix sandbox failure (attempt ${attempts})`,
      [
        `TASK:\n${prompt}`,
        '',
        `ARCHITECT PLAN:\n${architect.content}`,
        '',
        `SANDBOX FAILURE (3-line distillation):\n${failure}`,
        '',
        'Find the root cause and apply the smallest correct fix. Read before editing. Do not commit.',
      ].join('\n'),
      true
    );

    const debuggerResult = await runWorker({
      agentId: 'dag-debugger',
      task: { ...debugTask, status: 'running' },
      plan: plan(prompt, [debugTask]),
      provider,
      workspaceContext: context.text,
      bus,
      toolbelt,
      signal,
      maxSteps: 12,
      onEvent: (event) => {
        onEvent?.(event);
        if (event.type === 'tool' && event.status === 'start') {
          onProgress({
            stage: 4,
            total: TOTAL,
            label: 'Debugger',
            detail: `Repair ${attempts}/2 · ${event.summary}`,
          });
        }
      },
    });
    tokens += debuggerResult.tokens;
    debuggerSummary = debuggerResult.summary;

    if (!debuggerResult.ok) {
      sandbox = { ok: false, output: debuggerResult.error ?? debuggerResult.summary };
      break;
    }

    sandbox = await runSandbox();
    if (!sandbox.ok) failures++;
  }

  if (!sandbox.ok) {
    const failure = lastLines(sandbox.output, 3);
    onProgress({
      stage: 4,
      total: TOTAL,
      label: 'Sandbox Testing · circuit breaker',
      detail: failure,
      failed: true,
    });
    return {
      ok: false,
      summary: 'Circuit breaker tripped after 3 sandbox failures.',
      tokens,
      changedFiles: collectFiles(coder),
      error: `Sandbox failed after 3 debugger attempts.\n\n${failure}`,
    };
  }

  const diff = await readDiff(cwd);
  const changedFiles = collectFiles(coder);

  const summary = [
    `DAG complete · ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed · ${tokens} tokens`,
    '',
    coder.summary.trim(),
    debuggerSummary ? `\nDebugger: ${debuggerSummary.trim()}` : '',
  ].filter(Boolean).join('\n');

  bus.post('dag-sandbox', 'verifier', 'summary', summary);

  return {
    ok: true,
    summary,
    tokens,
    changedFiles,
    diff,
  };
}
