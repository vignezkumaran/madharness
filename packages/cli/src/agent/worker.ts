import type { ProviderName } from '../types.js';
import type { ChatMessage, ToolDefinition } from '../providers/complete.js';
import { completeWithFallback } from '../providers/complete.js';
import type { MeshBus } from './bus.js';
import type {
  AgentPlan,
  AgentRole,
  BusKind,
  HarnessEvent,
  PlanTask,
  ToolOutcome,
  WorkerResult,
} from './types.js';
import { parseAgentReply, clipProtocolText } from './protocol.js';
import { Toolbelt, specsForRole, toolPrompt } from './tools.js';

export interface WorkerOptions {
  agentId: string;
  task: PlanTask;
  plan: AgentPlan;
  provider: ProviderName;
  workspaceContext: string;
  bus: MeshBus;
  toolbelt: Toolbelt;
  onEvent: (event: HarnessEvent) => void;
  signal?: AbortSignal;
  maxSteps?: number;
}

const ROLE_GUIDANCE: Record<AgentRole, string> = {
  supervisor: 'Coordinate the mesh and verify the final result.',
  architect: 'Inspect the code and produce a concrete implementation plan. Identify exact files, functions, and risks. Do not modify files. Post useful handoffs for the coder.',
  researcher: 'Investigate facts in the workspace and report concrete findings with file paths and line references. Do not modify files.',
  coder: 'Implement the task with minimal, precise edits. Read files before editing. Match existing conventions. Run focused checks when useful. Do not touch unrelated code.',
  verifier: 'Audit the implementation against the acceptance criteria. Read the diff and relevant files, run tests when useful, and report precise failures or approve. Do not modify files.',
  debugger: 'Find the root cause and apply the smallest correct fix. Read before editing and verify the fix.',
};

function systemPrompt(task: PlanTask): string {
  return [
    `You are the ${task.role.toUpperCase()} worker in MAD, a terminal multi-agent coding harness.`,
    ROLE_GUIDANCE[task.role],
    '',
    'You share a Mesh Bus blackboard with other agents. Use it to hand off facts, critiques, and results.',
    'Only use the tools listed below. Never invent file contents, command output, or APIs.',
    'Inspect before you edit. Prefer small, surgical changes. Keep final summaries short and factual.',
    '',
    'Available tools:',
    toolPrompt(task.role),
    '',
    'If native tools are provided, call them directly. Otherwise use the JSON action protocol below.',
    'RESPONSE PROTOCOL — when not using native tools, reply with EXACTLY ONE JSON object and nothing else.',
    'To call a tool:',
    '{"thought":"why this step","action":{"tool":"read_file","args":{"path":"src/a.ts"}}}',
    'When the task is complete:',
    '{"thought":"brief rationale","done":true,"summary":"what you did, verified, or found"}',
    'Do not wrap JSON in markdown fences. Do not write prose outside the JSON.',
  ].join('\n');
}

function buildInitialMessage(options: WorkerOptions): string {
  const { task, plan, workspaceContext, bus } = options;
  const deps = plan.tasks.filter((candidate) => task.dependsOn.includes(candidate.id) && candidate.summary);
  const depText = deps.length
    ? deps.map((dep) => `[${dep.id} · ${dep.role}] ${dep.summary}`).join('\n\n')
    : '(no dependency summaries)';

  return [
    `OVERALL GOAL:\n${plan.summary}`,
    `ACCEPTANCE CRITERIA:\n${plan.acceptance.map((item) => `- ${item}`).join('\n') || '- Task completes correctly'}`,
    '',
    `YOUR TASK (${task.id} · ${task.role}): ${task.title}\n${task.task}`,
    '',
    `DEPENDENCY OUTPUTS:\n${depText}`,
    '',
    `AGENT COMMUNICATION LOG (recent, use read_bus for more):\n${bus.snapshot(10, 420)}`,
    '',
    `WORKSPACE CONTEXT (distilled):\n${workspaceContext}`,
    '',
    'Start now. Your first reply must be a tool call or done=true.',
  ].join('\n');
}

function describeTool(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : '';
  switch (name) {
    case 'read_file': return `Read ${path}`;
    case 'list_files': return `List ${path || '.'}`;
    case 'search_files': return `Search "${String(args.pattern ?? '')}"`;
    case 'glob_files': return `Glob ${String(args.pattern ?? '')}`;
    case 'distill_file': return `Distill ${path}`;
    case 'git_status': return 'Git status';
    case 'git_diff': return 'Git diff';
    case 'read_bus': return `Read agent log${args.agentId ? ` (${String(args.agentId)})` : ''}`;
    case 'post_to_bus': return `Post ${String(args.kind ?? 'note')} to Mesh`;
    case 'write_file': return `Write ${path}`;
    case 'edit_file': return `Edit ${path}`;
    case 'run_shell': return `Run ${String(args.command ?? '')}`;
    default: return name;
  }
}

const NATIVE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Workspace-relative file or directory path.' },
    offset: { type: 'number', description: '1-based line offset for read_file.' },
    limit: { type: 'number', description: 'Maximum lines to read.' },
    pattern: { type: 'string', description: 'Regex for search_files or glob pattern for glob_files.' },
    include: { type: 'string', description: 'Optional file glob filter for search_files.' },
    depth: { type: 'number', description: 'Directory depth for list_files.' },
    cached: { type: 'boolean', description: 'Read the staged diff for git_diff.' },
    agentId: { type: 'string', description: 'Agent id filter for read_bus.' },
    count: { type: 'number', description: 'Number of recent entries for read_bus.' },
    kind: { type: 'string', enum: ['handoff', 'critique', 'note', 'summary'], description: 'Mesh Bus message kind.' },
    content: { type: 'string', description: 'File contents or bus message body.' },
    find: { type: 'string', description: 'Exact snippet to replace in edit_file.' },
    replace: { type: 'string', description: 'Replacement snippet for edit_file.' },
    all: { type: 'boolean', description: 'Replace every match in edit_file.' },
    command: { type: 'string', description: 'Shell command to run.' },
    timeoutMs: { type: 'number', description: 'Shell timeout in milliseconds.' },
  },
  additionalProperties: false,
};

const NATIVE_REQUIRED: Record<string, string[]> = {
  read_file: ['path'],
  list_files: [],
  search_files: ['pattern'],
  glob_files: ['pattern'],
  distill_file: ['path'],
  git_status: [],
  git_diff: [],
  post_to_bus: ['kind', 'content'],
  write_file: ['path', 'content'],
  edit_file: ['path', 'find', 'replace'],
  run_shell: ['command'],
};

function nativeToolDefinitions(role: PlanTask['role']): ToolDefinition[] {
  return specsForRole(role).map((spec) => ({
    name: spec.name,
    description: `${spec.description}\nExpected args: ${spec.input}`,
    parameters: {
      ...NATIVE_SCHEMA,
      required: NATIVE_REQUIRED[spec.name] ?? [],
    },
  }));
}

function clipMessages(messages: ChatMessage[], maxChars = 48_000): ChatMessage[] {
  const total = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= maxChars) return messages;

  const system = messages[0]!;
  const initial = messages[1]!;
  const tail: ChatMessage[] = [];
  let used = system.content.length + initial.content.length;

  for (let i = messages.length - 1; i >= 2; i--) {
    const message = messages[i]!;
    const clipped = message.content.length > 8_000
      ? `${message.content.slice(0, 8_000)}\n…[truncated]`
      : message.content;
    if (used + clipped.length > maxChars && tail.length >= 4) break;
    tail.unshift({ ...message, content: clipped });
    used += clipped.length;
  }

  return [system, initial, ...tail];
}

export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const { agentId, task, provider, bus, toolbelt, onEvent, signal } = options;
  const maxSteps = options.maxSteps ?? 14;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(task) },
    { role: 'user', content: buildInitialMessage(options) },
  ];

  const toolsUsed: string[] = [];
  const changedFiles = new Set<string>();
  let tokens = 0;
  let usedProvider = provider;
  let invalidReplies = 0;

  const post = (kind: BusKind, content: string) =>
    bus.post(agentId, task.role, kind, content);

  post('note', `started: ${task.title}`);

  const result = (ok: boolean, summary: string, error?: string): WorkerResult => ({
    ok,
    summary,
    tokens,
    provider: usedProvider,
    toolsUsed,
    changedFiles: [...changedFiles],
    ...(error ? { error } : {}),
  });

  const runTool = async (tool: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
    const summary = describeTool(tool, args);
    onEvent({ type: 'tool', agentId, role: task.role, tool, summary, status: 'start' });
    if (tool !== 'read_bus') post('note', `▶ ${summary}`);

    if (tool === 'read_bus') {
      const count = Math.min(40, Math.max(1, Number(args.count ?? 12) || 12));
      const filter = String(args.agentId ?? '').trim();
      const entries = filter
        ? bus.all().filter((entry) => entry.agentId === filter || entry.role === filter).slice(-count)
        : bus.recent(count);
      const output = bus.snapshotEntries(entries, 700);
      const outcome: ToolOutcome = { ok: true, output };
      onEvent({
        type: 'tool',
        agentId,
        role: task.role,
        tool,
        summary,
        status: 'ok',
        detail: clipProtocolText(output, 900),
      });
      post('note', `✓ ${summary}`);
      return outcome;
    }

    const outcome = await toolbelt.run(tool, args, {
      agentId,
      role: task.role,
      signal,
      postToBus: (kind, content) => post(kind, content),
    });

    toolsUsed.push(tool);
    for (const file of outcome.changedFiles ?? []) changedFiles.add(file);

    onEvent({
      type: 'tool',
      agentId,
      role: task.role,
      tool,
      summary,
      status: outcome.ok ? 'ok' : 'error',
      detail: clipProtocolText(outcome.output, 900),
    });
    post('note', `${outcome.ok ? '✓' : '✗'} ${summary}${outcome.ok ? '' : ` · ${clipProtocolText(outcome.output, 180)}`}`);

    return outcome;
  };

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {

      return result(false, 'Cancelled by user.', 'Cancelled');
    }

    const response = await completeWithFallback(usedProvider, clipMessages(messages), {
      maxTokens: 2_200,
      temperature: 0.15,
      signal,
      reasoningEffort: 'low',
      tools: nativeToolDefinitions(task.role),
    });

    usedProvider = response.provider;
    tokens += response.tokens;
    onEvent({ type: 'tokens', provider: response.provider, tokens: response.tokens, model: response.model });

    const nativeCalls = response.toolCalls ?? [];
    const nativeProvider = response.provider === 'groq' || response.provider === 'codex';

    // ── Native tool calls (Groq / OpenAI-compatible) ──────────────────────
    if (nativeCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: nativeCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.rawArgs },
        })),
      });

      for (const call of nativeCalls) {
        if (signal?.aborted) return result(false, 'Cancelled by user.', 'Cancelled');
        const outcome = await runTool(call.name, call.args);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: `TOOL RESULT ${call.name} [${outcome.ok ? 'ok' : 'error'}]\n${clipProtocolText(outcome.output, 8_000)}`,
        });
      }

      invalidReplies = 0;
      continue;
    }

    // ── Text tool protocol (fallback providers, or text-mode replies) ──────
    const parsed = parseAgentReply(response.content);

    if (!parsed.ok) {
      if (nativeProvider && response.content.trim()) {
        const canFinishWithProse = toolsUsed.length > 0
          || (task.role !== 'coder' && task.role !== 'debugger');
        if (canFinishWithProse) {
          const summary = response.content.trim();
          post('summary', summary);
          return result(true, summary);
        }
      }

      invalidReplies++;
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [
          `Invalid reply (${parsed.error})`,
          'Reply with exactly one JSON object, no markdown. Example:',
          '{"thought":"...","action":{"tool":"read_file","args":{"path":"..."}}}',
          'or: {"thought":"...","done":true,"summary":"..."}',
        ].join('\n'),
      });

      if (invalidReplies >= 2) {
        return result(
          false,
          `Worker ${task.role} failed to follow the tool protocol.`,
          clipProtocolText(response.content, 500)
        );
      }
      continue;
    }

    const reply = parsed.reply;

    if (reply.thought) {
      onEvent({ type: 'thinking', agentId, role: task.role, text: clipProtocolText(reply.thought, 700) });
      post('thought', clipProtocolText(reply.thought, 320));
    }

    if (reply.done) {
      const summary = (reply.summary ?? 'Task complete.').trim();
      post('summary', summary);
      return result(true, summary);
    }

    if (!reply.action) {
      invalidReplies++;
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: 'Reply must contain an action or done=true.' });
      if (invalidReplies >= 2) {
        return result(false, `Worker ${task.role} produced no action.`, 'No action produced');
      }
      continue;
    }

    const { tool, args } = reply.action;
    const outcome = await runTool(tool, args);

    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: `TOOL RESULT ${tool} [${outcome.ok ? 'ok' : 'error'}]\n${clipProtocolText(outcome.output, 8_000)}`,
    });
  }

  const summary = `Reached the ${maxSteps}-step limit before finishing.`;
  post('handoff', summary);
  return result(false, summary, 'Step limit reached');
}
