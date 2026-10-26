import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import type { ProviderName } from '../types.js';
import { completeWithFallback, type ChatMessage } from '../providers/complete.js';
import { providerManager } from '../providers/manager.js';
import { MeshBus } from './bus.js';
import { collectRepoContext } from './context.js';
import { extractJsonObject } from './protocol.js';
import { Toolbelt } from './tools.js';
import { runWorker } from './worker.js';
import type {
  AgentPlan,
  AgentRole,
  AgentRunOptions,
  AgentRunResult,
  PlanTask,
  SupervisorDecision,
  WorkerResult,
} from './types.js';

const execFileAsync = promisify(execFile);

const PLAN_SYSTEM = `You are the Supervisor of MAD, a terminal multi-agent coding harness.
Decide whether the user's request needs code changes or is just a question.

Reply with EXACTLY ONE JSON object, no markdown fences.

If no file changes or commands are needed (pure question / explanation), use:
{"mode":"answer","summary":"one line","answer":"complete answer for the user"}

If the workspace must be inspected or changed, use:
{"mode":"plan","summary":"one line goal","tasks":[{"id":"t1","role":"architect|researcher|coder|verifier|debugger","title":"short title","task":"precise instructions","dependsOn":[],"writes":false}],"acceptance":["observable criterion"]}

Rules:
- Use 2-5 tasks. Research/architect tasks can run in parallel; coder tasks write files and run one at a time.
- Set writes=true only for coder/debugger tasks.
- Add a verifier task that depends on the coder task when code changes are expected.
- Dependencies must reference earlier task ids and never form cycles.
- Be specific about files and desired behavior. Do not invent APIs.
- For a simple, obvious change, 2 tasks (coder + verifier) are enough.`;


function looksLikeCodeTask(prompt: string): boolean {
  const action = /\b(fix|add|implement|update|change|refactor|remove|delete|create|build|write|rename|move|install|upgrade|migrate|debug|test|run|ship|make)\b/i;
  const file = /\b[\w./-]+\.(py|ts|tsx|js|jsx|json|md|ya?ml|toml|go|rs|java|rb|c|h|cpp)\b/i;
  return action.test(prompt) || file.test(prompt);
}

function normaliseRole(value: unknown): AgentRole {
  const role = String(value ?? '').toLowerCase();
  if (role === 'architect' || role === 'coder' || role === 'verifier' || role === 'researcher' || role === 'debugger') {
    return role;
  }
  return 'researcher';
}

function normaliseDecision(raw: Record<string, unknown>): SupervisorDecision | null {
  const mode = String(raw.mode ?? (raw.answer ? 'answer' : 'plan')).toLowerCase();
  const summary = typeof raw.summary === 'string' ? raw.summary : '';

  if (mode === 'answer') {
    const answer = typeof raw.answer === 'string' ? raw.answer : '';
    if (!answer.trim()) return null;
    return { mode: 'answer', summary: summary || 'Answering directly', answer };
  }

  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const acceptance = Array.isArray(raw.acceptance)
    ? raw.acceptance.map((item) => String(item)).filter(Boolean)
    : [];

  const tasks: PlanTask[] = [];
  const seen = new Set<string>();

  rawTasks.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const value = item as Record<string, unknown>;
    let id = String(value.id ?? `t${index + 1}`).replace(/[^\w-]/g, '') || `t${index + 1}`;
    while (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);

    const role = normaliseRole(value.role);
    const writes = role === 'coder' || role === 'debugger'
      ? value.writes !== false
      : Boolean(value.writes);
    const rawDeps = Array.isArray(value.dependsOn) ? value.dependsOn.map(String) : [];
    const dependsOn = rawDeps.filter((dep) => dep !== id);

    tasks.push({
      id,
      role,
      title: String(value.title ?? `${role} task`).slice(0, 120),
      task: String(value.task ?? value.description ?? '').trim(),
      dependsOn,
      writes,
      status: 'pending',
    });
  });

  if (tasks.length === 0) return null;

  const byId = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter((dep) => byId.has(dep));
  }

  return {
    mode: 'plan',
    summary: summary || 'Multi-agent task',
    tasks,
    acceptance: acceptance.length ? acceptance : ['Requested behavior is implemented and verified'],
  };
}

function fallbackPlan(prompt: string): AgentPlan {
  return {
    mode: 'plan',
    summary: prompt.slice(0, 160),
    tasks: [
      {
        id: 't1',
        role: 'architect',
        title: 'Inspect the relevant code',
        task: `Inspect the workspace and produce a precise implementation plan for: ${prompt}`,
        dependsOn: [],
        writes: false,
        status: 'pending',
      },
      {
        id: 't2',
        role: 'coder',
        title: 'Implement the change',
        task: `Implement this request using the architect's handoff: ${prompt}`,
        dependsOn: ['t1'],
        writes: true,
        status: 'pending',
      },
      {
        id: 't3',
        role: 'verifier',
        title: 'Verify the change',
        task: 'Audit the working tree diff against the original request. Run focused checks when useful. Report concrete issues or approve.',
        dependsOn: ['t2'],
        writes: false,
        status: 'pending',
      },
    ],
    acceptance: ['The requested change is implemented and passes available checks'],
  };
}

function cloneTask(task: PlanTask): PlanTask {
  return { ...task, dependsOn: [...task.dependsOn] };
}

function buildPlanPost(plan: AgentPlan): string {
  return [
    plan.summary,
    ...plan.tasks.map((task) => `${task.id} [${task.role}${task.writes ? ' · writes' : ''}] ${task.title}`),
    `acceptance: ${plan.acceptance.join('; ')}`,
  ].join('\n');
}

async function askForPlan(
  provider: ProviderName,
  prompt: string,
  workspaceContext: string,
  onEvent: AgentRunOptions['onEvent'],
  signal?: AbortSignal
): Promise<{ decision: SupervisorDecision; tokens: number; provider: ProviderName }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PLAN_SYSTEM },
    {
      role: 'user',
      content: [
        `USER REQUEST:\n${prompt}`,
        '',
        `WORKSPACE CONTEXT (distilled):\n${workspaceContext}`,
        '',
        'Return the JSON decision now.',
      ].join('\n'),
    },
  ];

  const response = await completeWithFallback(provider, messages, {
    maxTokens: 1_400,
    temperature: 0.1,
    reasoningEffort: 'low',
    signal,
  });

  onEvent({ type: 'tokens', provider: response.provider, tokens: response.tokens, model: response.model });

  const raw = extractJsonObject(response.content);
  const decision = raw ? normaliseDecision(raw) : null;

  if (decision) {
    return { decision, tokens: response.tokens, provider: response.provider };
  }

  if (looksLikeCodeTask(prompt)) {
    return { decision: fallbackPlan(prompt), tokens: response.tokens, provider: response.provider };
  }

  return {
    decision: {
      mode: 'answer',
      summary: 'Direct answer',
      answer: response.content.trim(),
    },
    tokens: response.tokens,
    provider: response.provider,
  };
}

async function answerDirectly(
  primary: ProviderName,
  prompt: string,
  workspaceContext: string,
  onEvent: AgentRunOptions['onEvent'],
  signal?: AbortSignal
): Promise<{ content: string; tokens: number }> {
  const response = await completeWithFallback(primary, [
    {
      role: 'system',
      content: 'You are MAD, a concise senior software engineer in a terminal. Use the distilled workspace context when relevant. Never invent file contents. Answer directly and keep it tight.',
    },
    { role: 'user', content: `REQUEST:\n${prompt}\n\nWORKSPACE CONTEXT:\n${workspaceContext}` },
  ], {
    maxTokens: 2_800,
    temperature: 0.2,
    reasoningEffort: 'low',
    signal,
  });

  onEvent({ type: 'tokens', provider: response.provider, tokens: response.tokens, model: response.model });
  return { content: response.content.trim(), tokens: response.tokens };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const started = Date.now();
  const primary = options.provider ?? providerManager.getFirstConnectedProvider();

  if (!primary) {
    throw new Error([
      'No model is connected.',
      'Run: mad auth   and paste any provider API key (auto-detected).',
      'Then start the harness again.',
    ].join('\n'));
  }

  if (providerManager.isLocalAgentName(primary)) {
    throw new Error(
      'The multi-agent mesh needs a cloud or Ollama provider. Local CLI agents are available for direct chat: use `mad ask` or the interactive TUI.'
    );
  }

  const emit = options.onEvent;
  const signal = options.signal;
  const bus = new MeshBus(emit);
  const toolbelt = new Toolbelt(options.cwd, options.approve, options.allowAlways);
  const allProviders = new Set<ProviderName>([primary]);
  let totalTokens = 0;

  bus.post('user', 'user', 'note', options.prompt);

  emit({ type: 'status', text: 'Scanning workspace and distilling context…' });
  const context = await collectRepoContext(options.cwd, options.prompt);
  emit({
    type: 'status',
    text: `Context ready · ${context.files.length} relevant file(s) distilled · branch ${context.branch || '(detached)'}${context.testCommand ? ` · check: ${context.testCommand}` : ''}`,
  });

  emit({ type: 'status', text: `Supervisor planning with ${providerManager.getProviderDisplayName(primary)}…` });
  const planned = await askForPlan(primary, options.prompt, context.text, emit, signal);
  totalTokens += planned.tokens;
  allProviders.add(planned.provider);

  if (signal?.aborted) {
    return {
      ok: false,
      content: 'Cancelled by user.',
      tasks: [],
      tokens: totalTokens,
      providers: [...allProviders],
      duration: Date.now() - started,
      changedFiles: [],
    };
  }

  if (planned.decision.mode === 'answer') {
    let answer = planned.decision.answer;
    if (!answer.trim()) {
      const direct = await answerDirectly(planned.provider, options.prompt, context.text, emit, signal);
      answer = direct.content;
      totalTokens += direct.tokens;
    }
    bus.post('supervisor', 'supervisor', 'summary', answer);
    emit({ type: 'assistant', content: answer });
    return {
      ok: true,
      content: answer,
      tasks: [],
      tokens: totalTokens,
      providers: [...allProviders],
      duration: Date.now() - started,
      changedFiles: [],
    };
  }

  const plan = planned.decision;
  bus.post('supervisor', 'supervisor', 'plan', buildPlanPost(plan));
  emit({ type: 'plan', plan });

  const results = new Map<string, WorkerResult>();
  const pending = new Set(plan.tasks.map((task) => task.id));
  const allWorkers: WorkerResult[] = [];

  const chooseProvider = (role: AgentRole): ProviderName => {
    if (role === 'researcher') {
      const cheap = providerManager.pickCheapest();
      if (cheap) return cheap;
    }
    return primary;
  };

  const runTask = async (task: PlanTask): Promise<void> => {
    task.status = 'running';
    task.startedAt = Date.now();
    task.provider = chooseProvider(task.role);
    allProviders.add(task.provider);
    emit({ type: 'agent', task: cloneTask(task) });

    try {
      const result = await runWorker({
        agentId: task.id,
        task,
        plan,
        provider: task.provider,
        workspaceContext: context.text,
        bus,
        toolbelt,
        onEvent: emit,
        signal,
        maxSteps: options.maxSteps ?? 14,
      });

      task.status = result.ok ? 'done' : 'failed';
      task.provider = result.provider;
      task.summary = result.summary;
      task.error = result.error;
      task.tokens = result.tokens;
      task.toolsUsed = result.toolsUsed;
      task.endedAt = Date.now();
      totalTokens += result.tokens;
      allProviders.add(result.provider);
      results.set(task.id, result);
      allWorkers.push(result);
      bus.post(task.id, task.role, result.ok ? 'result' : 'critique', result.summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      task.status = 'failed';
      task.error = message;
      task.summary = message;
      task.endedAt = Date.now();
      const failed: WorkerResult = {
        ok: false,
        summary: `${task.role} failed: ${message}`,
        tokens: 0,
        provider: task.provider ?? primary,
        toolsUsed: [],
        changedFiles: [],
        error: message,
      };
      results.set(task.id, failed);
      allWorkers.push(failed);
      bus.post(task.id, task.role, 'critique', failed.summary);
    } finally {
      emit({ type: 'agent', task: cloneTask(task) });
    }
  };

  // ── Execute the task graph ──────────────────────────────────────────────
  while (pending.size > 0) {
    if (signal?.aborted) break;

    // Skip tasks whose dependencies failed or were skipped.
    let skippedAny = false;
    for (const id of Array.from(pending)) {
      const task = plan.tasks.find((candidate) => candidate.id === id)!;
      const badDep = task.dependsOn.find((dep) => {
        const depTask = plan.tasks.find((candidate) => candidate.id === dep);
        return depTask && (depTask.status === 'failed' || depTask.status === 'skipped');
      });
      if (badDep) {
        task.status = 'skipped';
        task.error = `Skipped because dependency ${badDep} did not complete.`;
        task.endedAt = Date.now();
        pending.delete(id);
        emit({ type: 'agent', task: cloneTask(task) });
        skippedAny = true;
      }
    }

    const ready = plan.tasks.filter((task) => {
      if (!pending.has(task.id)) return false;
      return task.dependsOn.every((dep) => {
        const depTask = plan.tasks.find((candidate) => candidate.id === dep);
        return depTask?.status === 'done';
      });
    });

    if (ready.length === 0) {
      if (skippedAny) continue;
      // Dependency cycle or deadlock: fail remaining tasks.
      for (const id of Array.from(pending)) {
        const task = plan.tasks.find((candidate) => candidate.id === id)!;
        task.status = 'skipped';
        task.error = 'Skipped due to an unresolved dependency cycle.';
        emit({ type: 'agent', task: cloneTask(task) });
        pending.delete(id);
      }
      break;
    }

    const reads = ready.filter((task) => !task.writes);
    const writes = ready.filter((task) => task.writes);

    if (reads.length > 0) {
      emit({ type: 'status', text: `Mesh layer: ${reads.length} read-only worker(s) in parallel…` });
      await mapLimit(reads, 3, async (task) => {
        pending.delete(task.id);
        await runTask(task);
      });
    }

    for (const task of writes) {
      pending.delete(task.id);
      emit({ type: 'status', text: `Coder lane: ${task.title}…` });
      await runTask(task);
    }
  }

  const changedFiles = Array.from(new Set(allWorkers.flatMap((result) => result.changedFiles)));

  // ── Verification gate ───────────────────────────────────────────────────
  const failedTasks = plan.tasks.filter((task) => task.status === 'failed');
  const fatalFailures = failedTasks.filter((task) => task.writes || task.role === 'coder' || task.role === 'debugger');
  const maxRounds = options.maxRounds ?? 2;

  if (fatalFailures.length > 0) {
    const completed = plan.tasks.filter((task) => task.status === 'done');
    const content = [
      `Run incomplete — ${fatalFailures.length} writing worker(s) failed.`,
      '',
      ...fatalFailures.map((task) => {
        const detail = (task.error || task.summary || 'unknown error')
          .split('\n')
          .slice(0, 4)
          .join('\n  ');
        return `✗ ${task.role} · ${task.title}\n  ${detail}`;
      }),
      '',
      `Completed: ${completed.length ? completed.map((task) => `${task.role} · ${task.title}`).join(', ') : 'none'}`,
      `Changed files: ${changedFiles.length ? changedFiles.join(', ') : 'none'}`,
      'No final verification ran because a writing worker failed.',
    ].join('\n');

    return finishRun(content, false);
  }

  if (signal?.aborted) {
    return finishRun('Run cancelled before a final report was produced.', false);
  }

  // ── Verifier gate (no extra supervisor LLM call) ────────────────────────
  const looksLikeIssue = (summary: string): boolean => {
    const cleaned = summary.replace(/\bno (?:errors?|issues?|failures?|problems?)\b/gi, '');
    return /\b(failed|failure|errors?|mismatch|missing|incorrect|broken|does not|doesn't|could not|cannot|unable|rejected|not found|not present)\b/i.test(cleaned);
  };

  const writeTasks = plan.tasks.filter((task) => task.writes && task.status === 'done');
  let verification: PlanTask | undefined;
  let verificationFailed = false;
  let needsFix = false;

  if (changedFiles.length > 0) {
    verification = [...plan.tasks].reverse().find((task) => task.role === 'verifier');
    const lastWriteEnd = Math.max(0, ...writeTasks.map((task) => task.endedAt ?? task.startedAt ?? 0));
    const staleVerifier = !verification
      || verification.status === 'pending'
      || (verification.endedAt ?? 0) < lastWriteEnd;

    if (staleVerifier) {
      verification = {
        id: 'verify-final',
        role: 'verifier',
        title: 'Verify the working tree',
        task: 'Audit the working tree against the acceptance criteria. Read the changed files, run focused checks if useful, and report whether the result is correct. Do not modify files.',
        dependsOn: writeTasks.map((task) => task.id),
        writes: false,
        status: 'pending',
      };
      plan.tasks.push(verification);
      emit({ type: 'plan', plan });
      await runTask(verification);
    }

    if (!verification) {
      return finishRun('Verification could not be scheduled.', false);
    }

    verificationFailed = verification.status === 'failed';
    needsFix = verification.status === 'done' && looksLikeIssue(verification.summary ?? '');

    for (let round = 1; needsFix && round <= maxRounds && !signal?.aborted; round++) {
      const fixes = verification?.summary ?? 'Verifier reported an unspecified issue.';

      const fixTask: PlanTask = {
        id: `fix-${round}`,
        role: 'coder',
        title: `Fix verifier findings`,
        task: [
          'The verifier reported the following issue. Apply the smallest correct fix.',
          '',
          fixes,
          '',
          'Do not repeat work that is already correct. Summarize exactly what changed.',
        ].join('\n'),
        dependsOn: [],
        writes: true,
        status: 'pending',
      };

      plan.tasks.push(fixTask);
      emit({ type: 'plan', plan });
      bus.post('supervisor', 'supervisor', 'handoff', `Fix round ${round}: ${fixes.slice(0, 800)}`);
      await runTask(fixTask);

      if (fixTask.status === 'failed') {
        const content = [
          'Run incomplete — the fix worker failed.',
          '',
          `✗ ${fixTask.error || fixTask.summary || 'unknown error'}`,
          '',
          `Changed files: ${changedFiles.length ? changedFiles.join(', ') : 'none'}`,
        ].join('\n');
        return finishRun(content, false);
      }

      const reverify: PlanTask = {
        id: `verify-${round}`,
        role: 'verifier',
        title: `Re-verify after fix ${round}`,
        task: 'Re-check the acceptance criteria after the fix. Read the changed files, run focused checks if useful, and report approval or precise remaining issues. Do not modify files.',
        dependsOn: [fixTask.id],
        writes: false,
        status: 'pending',
      };

      plan.tasks.push(reverify);
      emit({ type: 'plan', plan });
      await runTask(reverify);
      verification = reverify;
      verificationFailed = reverify.status === 'failed';
      needsFix = reverify.status === 'done' && looksLikeIssue(reverify.summary ?? '');

      if (verificationFailed) break;
    }
  }

  const changedLines = changedFiles.length
    ? `Changed files:\n${changedFiles.map((file) => `- ${file}`).join('\n')}`
    : 'No files were changed.';

  let content: string;

  if (changedFiles.length === 0) {
    const answers = plan.tasks
      .filter((task) => task.status === 'done' && task.summary)
      .map((task) => `${task.summary}`)
      .join('\n\n');
    content = answers || plan.summary;
  } else if (verificationFailed) {
    content = [
      'Changes applied, but verification could not complete.',
      '',
      changedLines,
      '',
      `Verification error: ${(verification?.error || verification?.summary || 'unknown error').split('\n')[0]}`,
      '',
      'Re-run verification with a connected provider, or inspect the diff with /diff.',
    ].join('\n');
  } else if (needsFix) {
    content = [
      'Changes applied, but the verifier still reports issues.',
      '',
      changedLines,
      '',
      `Verifier: ${verification?.summary ?? 'no summary'}`,
    ].join('\n');
  } else {
    const workerLines = allWorkers
      .filter((result) => result.ok && result.summary)
      .map((result) => `- ${result.provider}: ${result.summary.split('\n')[0]}`)
      .join('\n');

    content = [
      `✓ ${plan.summary}`,
      '',
      changedLines,
      verification?.summary ? `\nVerification:\n${verification.summary}` : '',
      workerLines ? `\nWorkers:\n${workerLines}` : '',
    ].filter(Boolean).join('\n');
  }

  const ok = changedFiles.length === 0 ? true : !verificationFailed && !needsFix;
  return finishRun(content, ok);

  function finishRun(finalContent: string, ok: boolean): AgentRunResult {
    bus.post('supervisor', 'supervisor', 'summary', finalContent);
    emit({ type: 'assistant', content: finalContent });
    return {
      ok,
      content: finalContent,
      plan,
      tasks: plan.tasks.map(cloneTask),
      tokens: totalTokens,
      providers: [...allProviders],
      duration: Date.now() - started,
      changedFiles,
    };
  }

}
