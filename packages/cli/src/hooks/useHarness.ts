import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderName } from '../types.js';
import { providerManager } from '../providers/manager.js';
import { gitTool } from '../tools/git.js';
import { runDag, type DagProgress as DagView } from '../agent/dag-runner.js';
import { streamChat } from '../providers/stream.js';
import { sessionStore } from '../storage/session-store.js';
import { distillSource } from '../agent/distill.js';
import { AGENT_ROLE_INFO } from '../agent/roles.js';
import type {
  AgentPlan,
  AgentRole,
  AgentTaskStatus,
  ApprovalDecision,
  ApprovalRequest,
  BusEntry,
  HarnessEvent,
  PlanTask,
} from '../agent/types.js';

const execFileAsync = promisify(execFile);

export type EntryKind = 'user' | 'assistant' | 'system' | 'error' | 'tool' | 'agent' | 'bus' | 'diff';

export interface TranscriptEntry {
  id: string;
  kind: EntryKind;
  title?: string;
  content: string;
  meta?: string;
  status?: 'ok' | 'error';
  at: number;
}

export interface AgentView {
  id: string;
  role: AgentRole;
  title: string;
  status: AgentTaskStatus;
  provider?: ProviderName;
  tokens?: number;
  tools: string[];
  summary?: string;
  current?: string;
  startedAt?: number;
  endedAt?: number;
}

export type PickerStatus = 'active' | 'connected' | 'offline' | 'idle' | 'running' | 'done' | 'failed' | 'skipped';

export type PickerAction =
  | { type: 'provider'; provider: ProviderName }
  | { type: 'model'; provider: ProviderName; model: string }
  | { type: 'agent'; agentId: string }
  | { type: 'role'; role: AgentRole };

export interface PickerItem {
  id: string;
  label: string;
  meta?: string;
  detail?: string;
  status?: PickerStatus;
  action: PickerAction;
}

export interface PickerState {
  kind: 'providers' | 'models' | 'agents';
  title: string;
  subtitle?: string;
  empty?: string;
  items: PickerItem[];
}

export interface HarnessState {
  entries: TranscriptEntry[];
  agents: Record<string, AgentView>;
  agentOrder: string[];
  plan?: AgentPlan;
  busy: boolean;
  phase: string;
  objective?: string;
  picker: PickerState | null;
  provider: ProviderName | null;
  awaitingProvider: ProviderName | null;
  awaitingKey: boolean;
  tokens: number;
  providerUsage: Record<string, number>;
  lastDiff?: string;
  error?: string;
  streaming?: string;
  dag?: DagView;
  busEntries: BusEntry[];
  history: string[];
  historyIndex: number;
  cwd: string;
  branch: string;
  sessionStart: number;
  lastRunMs?: number;
  clearKey: number;
}

type Action =
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'busy'; busy: boolean; phase?: string }
  | { type: 'phase'; phase: string }
  | { type: 'objective'; text: string }
  | { type: 'picker'; picker: PickerState | null }
  | { type: 'provider'; provider: ProviderName | null }
  | { type: 'awaiting'; provider: ProviderName | null }
  | { type: 'awaitingKey'; value: boolean }
  | { type: 'plan'; plan: AgentPlan }
  | { type: 'agent'; task: PlanTask }
  | { type: 'thinking'; agentId: string; text: string }
  | { type: 'tool'; agentId: string; role: AgentRole; tool: string; summary: string; status: 'start' | 'ok' | 'error'; detail?: string }
  | { type: 'tokens'; provider: ProviderName; tokens: number }
  | { type: 'diff'; text: string }
  | { type: 'streaming'; text?: string }
  | { type: 'dag'; progress?: DagView }
  | { type: 'bus'; entry: BusEntry }
  | { type: 'history'; value: string }
  | { type: 'historyIndex'; index: number }
  | { type: 'cwd'; cwd: string; branch: string }
  | { type: 'lastRunMs'; ms: number }
  | { type: 'clear' }
  | { type: 'error'; message?: string };

let entrySeq = 0;
function entryId(prefix = 'e'): string {
  entrySeq += 1;
  return `${prefix}-${Date.now()}-${entrySeq}`;
}

function transcriptEntry(kind: EntryKind, content: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    id: entryId(kind),
    kind,
    content,
    at: Date.now(),
    ...extra,
  };
}

function welcomeEntries(): TranscriptEntry[] {
  const connected = providerManager.getFirstConnectedProvider();
  const entries: TranscriptEntry[] = [
    transcriptEntry('system', [
      'MAD terminal agent — direct chat with your active model.',
      'Ask a question, or run /dag <task> for the hidden Architect → Coder → Sandbox → Debugger pipeline.',
      'Providers and models: /modelprovider · /models · agents: /agents',
    ].join('\n'), { title: 'ready' }),
  ];

  if (!connected) {
    entries.push(transcriptEntry('system', [
      'No model connected.',
      'Run: mad auth   and paste any provider API key (auto-detected).',
      'Inside the app: /login groq',
    ].join('\n'), { title: 'authentication' }));
  }

  return entries;
}

function initialAgents(plan: AgentPlan): { agents: Record<string, AgentView>; order: string[] } {
  const agents: Record<string, AgentView> = {};
  const order: string[] = [];
  for (const task of plan.tasks) {
    agents[task.id] = {
      id: task.id,
      role: task.role,
      title: task.title,
      status: task.status,
      provider: task.provider,
      tokens: task.tokens,
      tools: task.toolsUsed ?? [],
      summary: task.summary,
    };
    order.push(task.id);
  }
  return { agents, order };
}

function reducer(state: HarnessState, action: Action): HarnessState {
  switch (action.type) {
    case 'entry':
      return { ...state, entries: [...state.entries, action.entry] };

    case 'busy':
      return {
        ...state,
        busy: action.busy,
        phase: action.phase ?? (action.busy ? state.phase : 'Ready'),
      };

    case 'phase':
      return { ...state, phase: action.phase };

    case 'objective':
      return { ...state, objective: action.text };

    case 'picker':
      return { ...state, picker: action.picker };

    case 'provider':
      return { ...state, provider: action.provider };

    case 'awaiting':
      return { ...state, awaitingProvider: action.provider };

    case 'awaitingKey':
      return { ...state, awaitingKey: action.value };

    case 'plan': {
      const seeded = initialAgents(action.plan);
      return {
        ...state,
        plan: action.plan,
        agents: { ...state.agents, ...seeded.agents },
        agentOrder: [...new Set([...state.agentOrder, ...seeded.order])],
      };
    }

    case 'agent': {
      const task = action.task;
      const previous = state.agents[task.id];
      const agent: AgentView = {
        id: task.id,
        role: task.role,
        title: task.title,
        status: task.status,
        provider: task.provider,
        tokens: task.tokens,
        tools: task.toolsUsed ?? previous?.tools ?? [],
        summary: task.summary,
        current: task.status === 'running' ? previous?.current : undefined,
        startedAt: task.startedAt ?? previous?.startedAt,
        endedAt: task.endedAt,
      };

      const agents = { ...state.agents, [task.id]: agent };
      const agentOrder = state.agentOrder.includes(task.id)
        ? state.agentOrder
        : [...state.agentOrder, task.id];

      let entries = state.entries;
      const becameDone = task.status === 'done' && previous?.status !== 'done';
      const becameFailed = task.status === 'failed' && previous?.status !== 'failed';

      if (becameDone) {
        entries = [...entries, transcriptEntry('agent', task.summary || 'Task complete.', {
          title: `${task.role} · ${task.title}`,
          meta: [
            task.provider ? `via ${task.provider}` : '',
            task.tokens ? `${task.tokens.toLocaleString()} tok` : '',
            task.toolsUsed?.length ? `${task.toolsUsed.length} tool calls` : '',
          ].filter(Boolean).join(' · '),
          status: 'ok',
        })];
      } else if (becameFailed) {
        entries = [...entries, transcriptEntry('error', task.error || task.summary || 'Worker failed.', {
          title: `${task.role} · ${task.title}`,
          meta: task.provider ? `via ${task.provider}` : undefined,
          status: 'error',
        })];
      }

      return { ...state, agents, agentOrder, entries };
    }

    case 'thinking': {
      const previous = state.agents[action.agentId];
      if (!previous) return state;
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.agentId]: { ...previous, current: action.text },
        },
      };
    }

    case 'tool': {
      const previous = state.agents[action.agentId];
      const agents = previous
        ? {
            ...state.agents,
            [action.agentId]: {
              ...previous,
              current: action.status === 'start' ? action.summary : previous.current,
              tools: action.status === 'start'
                ? [...new Set([...previous.tools, action.tool])]
                : previous.tools,
            },
          }
        : state.agents;

      if (action.status === 'start') {
        return { ...state, agents };
      }

      const detail = (action.detail ?? '').trim();
      const snippet = detail
        ? detail.split('\n').slice(0, action.status === 'error' ? 10 : 3).join('\n')
        : '';
      const content = `${action.summary}${snippet ? `\n${snippet}` : ''}`;

      return {
        ...state,
        agents,
        entries: [
          ...state.entries,
          transcriptEntry('tool', content.slice(0, 1_600), {
            title: action.tool,
            meta: action.role,
            status: action.status,
          }),
        ],
      };
    }

    case 'tokens':
      return {
        ...state,
        tokens: state.tokens + action.tokens,
        providerUsage: {
          ...state.providerUsage,
          [action.provider]: (state.providerUsage[action.provider] ?? 0) + action.tokens,
        },
      };

    case 'diff':
      return { ...state, lastDiff: action.text };

    case 'streaming':
      return { ...state, streaming: action.text };

    case 'dag':
      return { ...state, dag: action.progress };

    case 'bus':
      return { ...state, busEntries: [...state.busEntries, action.entry].slice(-240) };

    case 'history':
      return {
        ...state,
        history: [...state.history, action.value].slice(-200),
        historyIndex: -1,
      };

    case 'historyIndex':
      return { ...state, historyIndex: action.index };

    case 'cwd':
      return { ...state, cwd: action.cwd, branch: action.branch };

    case 'lastRunMs':
      return { ...state, lastRunMs: action.ms };

    case 'clear':
      return {
        ...state,
        entries: welcomeEntries(),
        agents: {},
        agentOrder: [],
        plan: undefined,
        tokens: 0,
        providerUsage: {},
        busEntries: [],
        lastDiff: undefined,
        error: undefined,
        objective: undefined,
        picker: null,
        streaming: undefined,
        dag: undefined,
        clearKey: state.clearKey + 1,
        phase: 'Ready',
        awaitingProvider: null,
        awaitingKey: false,
      };

    case 'error':
      return { ...state, error: action.message };

    default:
      return state;
  }
}

function initialState(): HarnessState {
  const first = providerManager.getSavedProvider() ?? providerManager.getFirstConnectedProvider();
  return {
    entries: welcomeEntries(),
    agents: {},
    agentOrder: [],
    busy: false,
    phase: 'Ready',
    objective: undefined,
    picker: null,
    provider: first,
    awaitingProvider: null,
    awaitingKey: false,
    tokens: 0,
    providerUsage: {},
    busEntries: [],
    history: [],
    historyIndex: -1,
    cwd: process.cwd(),
    branch: '',
    sessionStart: Date.now(),
    clearKey: 0,
  };
}

function formatElapsed(start?: number, end?: number): string {
  if (!start) return '';
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pickerStatus(status: AgentTaskStatus): PickerStatus {
  return status === 'pending' ? 'idle' : status;
}

function planText(plan: AgentPlan): string {
  return [
    plan.summary,
    '',
    ...plan.tasks.map((task) => `${task.status === 'done' ? '✓' : task.status === 'failed' ? '✗' : task.status === 'running' ? '●' : '○'} ${task.id} [${task.role}${task.writes ? ' · writes' : ''}] ${task.title}${task.summary ? `\n   ↳ ${task.summary}` : ''}`),
    '',
    `Acceptance: ${plan.acceptance.join('; ')}`,
  ].join('\n');
}

const CHAT_SYSTEM = [
  'You are MAD, a direct, senior terminal coding assistant.',
  'Answer the user request precisely. Use short markdown when it helps.',
  'You do not have tools in chat mode; if a change requires editing files, tell the user to use /dag <task>.',
  'You can read the shared agent communication log below. When asked what an agent is doing, answer from that log.',
  'Never invent file contents, command output, or APIs.',
].join('\n');

function flatClip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function formatAgentLog(entries: BusEntry[], count = 18): string {
  const recent = entries.slice(-count);
  if (recent.length === 0) return '(no agent activity yet)';
  return recent
    .map((entry) => {
      const who = entry.role === 'user' ? 'user' : `${entry.role}/${entry.agentId}`;
      return `[${who} · ${entry.kind}] ${flatClip(entry.content, 420)}`;
    })
    .join('\n');
}

const HELP_TEXT = [
  'CHAT',
  '  <prompt>              Chat directly with the active model (streams)',
  '  /dag <task>           Run the hidden Architect → Coder → Sandbox → Debugger pipeline',
  '  /plan                 Show the current DAG plan',
  '  /agents               Browse agent roles and worker status',
  '  /diff                 Show the working tree diff',
  '  /status               Session, provider, and token status',
  '',
  'MODELS',
  '  /modelprovider        Choose a model provider',
  '  /models               Choose a model',
  '  /model [provider|id]  Switch provider or model directly',
  '  /login [provider|key] Connect a provider; auto-detects keys',
  '  /logout [provider]    Remove a key',
  '',
  'CONTEXT',
  '  /distill <file>       Show the distilled interface contract',
  '  /cwd [path]           Show or change the workspace',
  '  /permissions [clear]  Show or clear always-allow rules',
  '',
  'SESSION',
  '  /clear                Clear the screen and transcript',
  '  /cancel               Stop the running chat or DAG',
  '  /help                 This help',
  '  /exit                 Quit',
  '',
  'KEYS',
  '  Enter send · Tab agents · PgUp/PgDn scroll · Esc cancel · Ctrl+C quit',
].join('\n');

export function useHarness() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const approvalRef = useRef<ApprovalRequest | null>(null);
  const approvalResolver = useRef<((decision: ApprovalDecision) => void) | null>(null);
  const allowAlways = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const busLogRef = useRef<BusEntry[]>([]);
  const streamRef = useRef<string | undefined>(undefined);
  const sessionRef = useRef<string | null>(null);
  const tokensRef = useRef(0);

  const addSystem = useCallback((content: string, title?: string) => {
    dispatch({ type: 'entry', entry: transcriptEntry('system', content, { title }) });
  }, []);

  const addError = useCallback((content: string, title = 'error') => {
    dispatch({ type: 'entry', entry: transcriptEntry('error', content, { title, status: 'error' }) });
    dispatch({ type: 'error', message: content });
  }, []);

  useEffect(() => {
    void providerManager.warmLocalModels();
  }, []);

  useEffect(() => {
    sessionRef.current = sessionStore.startSession(
      process.cwd(),
      providerManager.getFirstConnectedProvider()
    );
    return () => {
      sessionStore.endSession(sessionRef.current, tokensRef.current);
    };
  }, []);

  useEffect(() => {
    tokensRef.current = state.tokens;
  }, [state.tokens]);

  useEffect(() => {
    const last = state.entries[state.entries.length - 1];
    if (last) sessionStore.addMessage(sessionRef.current, last.kind, last.content);
  }, [state.entries.length]);

  useEffect(() => {
    let cancelled = false;
    execFileAsync('git', ['branch', '--show-current'], { cwd: process.cwd(), timeout: 5000 })
      .then(({ stdout }) => {
        if (!cancelled) {
          dispatch({ type: 'cwd', cwd: process.cwd(), branch: stdout.trim() });
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const applyEvent = useCallback((event: HarnessEvent) => {
    switch (event.type) {
      case 'status':
        dispatch({ type: 'phase', phase: event.text });
        break;
      case 'plan':
        dispatch({ type: 'plan', plan: event.plan });
        break;
      case 'agent':
        dispatch({ type: 'agent', task: event.task });
        break;
      case 'thinking':
        dispatch({ type: 'thinking', agentId: event.agentId, text: event.text });
        break;
      case 'tool':
        dispatch({
          type: 'tool',
          agentId: event.agentId,
          role: event.role,
          tool: event.tool,
          summary: event.summary,
          status: event.status,
          detail: event.detail,
        });
        break;
      case 'bus':
        busLogRef.current = [...busLogRef.current, event.entry].slice(-240);
        dispatch({ type: 'bus', entry: event.entry });
        if (event.entry.kind === 'handoff' || event.entry.kind === 'critique') {
          dispatch({
            type: 'entry',
            entry: transcriptEntry('bus', event.entry.content, {
              title: `${event.entry.role} · ${event.entry.kind}`,
              meta: 'mesh',
            }),
          });
        }
        break;
      case 'tokens':
        dispatch({ type: 'tokens', provider: event.provider, tokens: event.tokens });
        break;
      case 'diff':
        dispatch({ type: 'diff', text: event.text });
        break;
      case 'assistant':
        dispatch({
          type: 'entry',
          entry: transcriptEntry('assistant', event.content, { title: 'MAD' }),
        });
        break;
      case 'error':
        addError(event.message);
        break;
      default:
        break;
    }
  }, [addError]);

  const approve = useCallback((request: ApprovalRequest): Promise<ApprovalDecision> => {
    approvalRef.current = request;
    setApproval(request);
    return new Promise<ApprovalDecision>((resolve) => {
      approvalResolver.current = resolve;
    });
  }, []);

  const respondApproval = useCallback((decision: ApprovalDecision) => {
    const request = approvalRef.current;
    if (decision === 'always' && request) {
      allowAlways.current.add(request.key);
    }
    approvalRef.current = null;
    setApproval(null);
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    resolve?.(decision);
  }, []);

  const requireProvider = useCallback((): ProviderName | null => {
    const provider = state.provider ?? providerManager.getFirstConnectedProvider();
    if (!provider) {
      addError(
        'No model connected.\nRun: mad auth and paste any provider API key; MAD auto-detects it.\nThen try again.',
        'authentication'
      );
      return null;
    }
    return provider;
  }, [state.provider, addError]);

  const startChat = useCallback(async (prompt: string) => {
    if (busyRef.current) {
      addSystem('A run is already active. Press Esc to cancel it first.', 'busy');
      return;
    }

    const provider = requireProvider();
    if (!provider) return;

    busyRef.current = true;
    dispatch({ type: 'objective', text: prompt });
    dispatch({ type: 'dag', progress: undefined });
    dispatch({ type: 'streaming', text: '' });
    dispatch({ type: 'entry', entry: transcriptEntry('user', prompt) });
    dispatch({ type: 'history', value: prompt });
    dispatch({ type: 'busy', busy: true, phase: 'Thinking…' });
    dispatch({ type: 'error', message: undefined });

    const controller = new AbortController();
    abortRef.current = controller;
    const started = Date.now();

    try {
      const result = await streamChat(
        provider,
        [
          { role: 'system', content: `${CHAT_SYSTEM}\n\nSHARED AGENT COMMUNICATION LOG:\n${formatAgentLog(busLogRef.current)}` },
          { role: 'user', content: prompt },
        ],
        { signal: controller.signal, maxTokens: 4096 },
        (delta) => {
          dispatch({ type: 'streaming', text: (streamRef.current ?? '') + delta });
          if (!streamRef.current) dispatch({ type: 'phase', phase: 'Streaming…' });
          streamRef.current = (streamRef.current ?? '') + delta;
        }
      );

      const content = result.content.trim();
      if (!content) throw new Error('The model returned an empty response.');
      dispatch({ type: 'streaming', text: undefined });
      streamRef.current = undefined;
      dispatch({
        type: 'entry',
        entry: transcriptEntry('assistant', content, {
          title: 'MAD',
          meta: [
            result.provider,
            result.model,
            result.tokens ? `${result.tokens.toLocaleString()} tok` : '',
          ].filter(Boolean).join(' · '),
        }),
      });
      dispatch({ type: 'tokens', provider: result.provider, tokens: result.tokens });
      dispatch({ type: 'lastRunMs', ms: Date.now() - started });
    } catch (err) {
      dispatch({ type: 'streaming', text: undefined });
      streamRef.current = undefined;
      if (controller.signal.aborted || (err as Error).name === 'AbortError') {
        addSystem('Chat cancelled.', 'cancelled');
      } else {
        addError(err instanceof Error ? err.message : String(err), 'chat failed');
      }
    } finally {
      busyRef.current = false;
      abortRef.current = null;
      dispatch({ type: 'busy', busy: false, phase: 'Ready' });
    }
  }, [requireProvider, addSystem, addError]);

  const startDag = useCallback(async (taskText: string) => {
    if (busyRef.current) {
      addSystem('A run is already active. Press Esc to cancel it first.', 'busy');
      return;
    }

    const provider = requireProvider();
    if (!provider) return;

    if (provider === 'opencode' || provider === 'pi') {
      addSystem(
        'The DAG pipeline needs a cloud or Ollama provider. Switch with /modelprovider; local CLI agents are for direct chat.',
        'dag'
      );
      return;
    }

    busyRef.current = true;
    dispatch({ type: 'streaming', text: undefined });
    dispatch({ type: 'objective', text: taskText });
    dispatch({ type: 'entry', entry: transcriptEntry('user', `/dag ${taskText}`) });
    dispatch({ type: 'history', value: `/dag ${taskText}` });
    dispatch({ type: 'busy', busy: true, phase: 'DAG · Pruning AST…' });
    dispatch({ type: 'error', message: undefined });
    dispatch({
      type: 'dag',
      progress: { stage: 1, total: 4, label: 'Architect', detail: 'Pruning AST…' },
    });

    const controller = new AbortController();
    abortRef.current = controller;
    const started = Date.now();
    const runId = sessionStore.startDag(sessionRef.current, taskText);

    try {
      const result = await runDag({
        prompt: taskText,
        cwd: state.cwd,
        provider,
        approve,
        signal: controller.signal,
        allowAlways: allowAlways.current,
        onProgress: (progress) => dispatch({ type: 'dag', progress }),
        onEvent: (event) => {
          if (event.type !== 'tokens') applyEvent(event);
        },
      });

      dispatch({ type: 'tokens', provider, tokens: result.tokens });

      if (result.ok) {
        sessionStore.finishDag(runId, 'done', result.tokens, result.changedFiles);
        dispatch({ type: 'dag', progress: undefined });
        const parts = [result.summary];
        if (result.changedFiles.length > 0) {
          parts.push(`Changed files:\n${result.changedFiles.map((file) => `- ${file}`).join('\n')}`);
        }
        if (result.diff) parts.push(`\`\`\`diff\n${result.diff}\n\`\`\``);
        dispatch({
          type: 'entry',
          entry: transcriptEntry('assistant', parts.join('\n\n'), {
            title: 'DAG complete',
            meta: `${providerManager.getProviderDisplayName(provider)} · ${result.tokens.toLocaleString()} tok`,
          }),
        });
      } else {
        sessionStore.finishDag(runId, 'failed', result.tokens, result.changedFiles, result.error);
        dispatch({
          type: 'dag',
          progress: {
            stage: 4,
            total: 4,
            label: 'DAG failed',
            detail: result.error?.split('\n').filter(Boolean).slice(-1)[0],
            failed: true,
          },
        });
        addError(result.error ?? result.summary, 'dag failed');
      }
      dispatch({ type: 'lastRunMs', ms: Date.now() - started });
    } catch (err) {
      if (controller.signal.aborted || (err as Error).name === 'AbortError') {
        sessionStore.finishDag(runId, 'cancelled', 0, [], 'cancelled');
        dispatch({ type: 'dag', progress: undefined });
        addSystem('DAG cancelled.', 'cancelled');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sessionStore.finishDag(runId, 'failed', 0, [], message);
        dispatch({
          type: 'dag',
          progress: { stage: 4, total: 4, label: 'DAG failed', detail: message.split('\n')[0], failed: true },
        });
        addError(message, 'dag failed');
      }
    } finally {
      busyRef.current = false;
      abortRef.current = null;
      dispatch({ type: 'busy', busy: false, phase: 'Ready' });
    }
  }, [requireProvider, state.cwd, approve, addSystem, addError, applyEvent]);

  const cancel = useCallback(() => {
    if (!abortRef.current) {
      addSystem('Nothing is running.', 'cancel');
      return;
    }
    abortRef.current.abort();
    dispatch({ type: 'phase', phase: 'Cancelling…' });
  }, [addSystem]);

  const login = useCallback((provider: ProviderName | null) => {
    if (provider && providerManager.isProviderDisabled(provider)) {
      addSystem(`${providerManager.getProviderDisplayName(provider)} is disabled. Run: mad config ${provider} --enable`, 'login');
      return;
    }
    if (provider && providerManager.isLocalAgentName(provider)) {
      dispatch({ type: 'awaiting', provider: null });
      dispatch({ type: 'awaitingKey', value: false });
      providerManager.setActiveProvider(provider);
      dispatch({ type: 'provider', provider });
      addSystem(
        `${providerManager.getProviderDisplayName(provider)} runs as a local CLI and is already detected. No API key needed. Its models are auto-imported into /models.`,
        'model'
      );
      return;
    }

    dispatch({ type: 'awaiting', provider });
    dispatch({ type: 'awaitingKey', value: !provider });
    if (!provider) {
      addSystem([
        'Paste any provider API key below, or /cancel.',
        'Auto-detected prefixes: Groq gsk_ · Anthropic sk-ant- · OpenAI sk- · Gemini AIza',
      ].join('\n'), 'login auto');
      return;
    }
    addSystem(`Paste the ${providerManager.getProviderDisplayName(provider)} API key below, or /cancel.`, `login ${provider}`);
  }, [addSystem]);

  const closePicker = useCallback(() => {
    dispatch({ type: 'picker', picker: null });
  }, []);

  const inspectAgent = useCallback((agentId: string) => {
    const agent = state.agents[agentId];
    if (!agent) {
      addSystem('That worker is no longer in this session.', 'mesh');
      return;
    }
    const icon = agent.status === 'done' ? '✓' : agent.status === 'failed' ? '✗' : agent.status === 'running' ? '●' : '○';
    addSystem([
      `${icon} ${agent.role} · ${agent.title}`,
      `Status:  ${agent.status}${agent.provider ? ` · ${agent.provider}` : ''}${agent.tokens ? ` · ${agent.tokens.toLocaleString()} tok` : ''}`,
      agent.startedAt ? `Elapsed: ${formatElapsed(agent.startedAt, agent.endedAt)}` : '',
      agent.current ? `Current: ${agent.current}` : '',
      agent.summary ? `Summary: ${agent.summary}` : '',
      agent.tools.length ? `Tools:   ${agent.tools.join(', ')}` : '',
    ].filter(Boolean).join('\n'), `agent ${agent.role}`);
  }, [addSystem, state.agents]);

  const inspectRole = useCallback((role: AgentRole) => {
    const info = AGENT_ROLE_INFO.find((entry) => entry.role === role);
    if (!info) return;
    addSystem([
      `${info.label} · ${info.role}`,
      info.detail,
      'Send a task to spawn this role when the supervisor needs it.',
    ].join('\n'), 'agent role');
  }, [addSystem]);

  const selectPicker = useCallback((item: PickerItem) => {
    dispatch({ type: 'picker', picker: null });
    const action = item.action;

    if (action.type === 'provider') {
      const provider = action.provider;
      const connected = providerManager.isConfigured(provider);
      if (!connected) {
        login(provider);
        return;
      }
      providerManager.setActiveProvider(provider);
      dispatch({ type: 'provider', provider });
      addSystem(`Active provider: ${providerManager.getProviderDisplayName(provider)} · ${providerManager.getProvider(provider)?.config.model}`, 'model');
      return;
    }

    if (action.type === 'model') {
      const { provider, model } = action;
      const connected = providerManager.isConfigured(provider);
      if (!connected) {
        login(provider);
        return;
      }
      providerManager.setModel(provider, model);
      providerManager.setActiveProvider(provider);
      dispatch({ type: 'provider', provider });
      addSystem(`Active model: ${providerManager.getProviderDisplayName(provider)} · ${model}`, 'model');
      return;
    }

    if (action.type === 'agent') {
      inspectAgent(action.agentId);
      return;
    }

    if (action.type === 'role') {
      inspectRole(action.role);
    }
  }, [addSystem, inspectAgent, inspectRole, login]);

  const handleCommand = useCallback(async (input: string): Promise<boolean> => {
    const [commandRaw, ...restParts] = input.slice(1).split(/\s+/);
    const command = (commandRaw ?? '').toLowerCase();
    const rest = restParts.join(' ').trim();

    switch (command) {
      case 'dag': {
        if (!rest) {
          addSystem('Usage: /dag <task>\nRuns Architect → Coder → Sandbox → Debugger and shows a violet progress bar.', 'dag');
          return true;
        }
        await startDag(rest);
        return true;
      }

      case 'help':
      case '?':
        addSystem(HELP_TEXT, 'help');
        return true;

      case 'exit':
      case 'quit':
        process.exit(0);
        return true;

      case 'clear':
      case 'new':
        process.stdout.write('\u001b[2J\u001b[H');
        busLogRef.current = [];
        dispatch({ type: 'clear' });
        return true;

      case 'cancel':
        cancel();
        return true;

      case 'login':
      case 'auth': {
        if (!rest) {
          login(null);
          return true;
        }

        const parts = rest.split(/\s+/).filter(Boolean);
        const explicitProvider = providerManager.resolveProviderName(parts[0] ?? '');
        const explicitKey = explicitProvider ? parts.slice(1).join(' ').trim() : '';

        if (explicitProvider && providerManager.isProviderDisabled(explicitProvider)) {
          addSystem(`${providerManager.getProviderDisplayName(explicitProvider)} is disabled. Enable it in ~/.config/mad-harness/config.json first.`, 'login');
          return true;
        }

        if (explicitProvider && providerManager.isLocalAgentName(explicitProvider)) {
          login(explicitProvider);
          return true;
        }

        if (explicitProvider && explicitKey) {
          if (explicitProvider === 'ollama') {
            addSystem('Ollama runs locally. Start it with `ollama serve`; select it with /model ollama.', 'login');
            return true;
          }
          providerManager.setApiKey(explicitProvider, explicitKey);
          dispatch({ type: 'awaiting', provider: null });
          dispatch({ type: 'awaitingKey', value: false });
          providerManager.setActiveProvider(explicitProvider);
          dispatch({ type: 'provider', provider: explicitProvider });
          addSystem(`Authenticated ${providerManager.getProviderDisplayName(explicitProvider)} (${providerManager.getMaskedKey(explicitProvider)}).`, 'login');
          return true;
        }

        if (!explicitProvider) {
          const detected = providerManager.detectProviderFromKey(rest);
          if (detected && providerManager.isProviderDisabled(detected)) {
            addSystem(`${providerManager.getProviderDisplayName(detected)} is disabled. Enable it in ~/.config/mad-harness/config.json first.`, 'login');
            return true;
          }
          if (detected) {
            providerManager.setApiKey(detected, rest);
            dispatch({ type: 'awaiting', provider: null });
            dispatch({ type: 'awaitingKey', value: false });
            providerManager.setActiveProvider(detected);
            dispatch({ type: 'provider', provider: detected });
            addSystem(`Detected ${providerManager.getProviderDisplayName(detected)} and connected it (${providerManager.getMaskedKey(detected)}).`, 'login');
            return true;
          }
          addSystem([
            `Could not detect a provider from that key.`,
            'Use /login <provider> and paste the key, or one of:',
            '  /login groq gsk_...',
            '  /login claude sk-ant-...',
            '  /login codex sk-...',
            '  /login gemini AIza...',
          ].join('\n'), 'login');
          return true;
        }

        login(explicitProvider);
        return true;
      }

      case 'logout':
      case 'block': {
        const provider = rest
          ? providerManager.resolveProviderName(rest.split(/\s+/)[0] ?? '')
          : state.provider;
        if (!provider) {
          addSystem('Specify a provider: /logout groq', 'logout');
          return true;
        }
        if (providerManager.isLocalAgentName(provider)) {
          addSystem(
            `${providerManager.getProviderDisplayName(provider)} is a local CLI with no stored key. Remove the binary from PATH to disable it.`,
            'logout'
          );
          return true;
        }
        providerManager.removeApiKey(provider);
        const next = providerManager.getFirstConnectedProvider();
        providerManager.setActiveProvider(next);
        dispatch({ type: 'provider', provider: next });
        addSystem(`Removed ${provider}${next ? `; active model is now ${next}.` : '. No models remain connected.'}`, 'logout');
        return true;
      }

      case 'modelprovider':
      case 'providers': {
        const items: PickerItem[] = Array.from(providerManager.getVisibleProviders().entries()).map(([name, provider]): PickerItem => {
          const connected = providerManager.isConfigured(name);
          const active = name === state.provider;
          const status = active ? 'active' : connected ? 'connected' : 'offline';
          return {
            id: `provider:${name}`,
            label: provider.config.displayName,
            meta: `${name} · ${provider.config.model} · ${
              providerManager.isLocalAgentName(name)
                ? connected ? 'local CLI · detected' : 'local CLI · missing'
                : name === 'ollama'
                  ? 'local'
                  : connected ? 'connected' : 'not connected'
            }`,
            detail: active
              ? 'Currently active.'
              : connected
                ? providerManager.isLocalAgentName(name)
                  ? 'Detected local CLI. Press Enter to use it; its models are auto-imported into /models.'
                  : 'Press Enter to activate this provider.'
                : 'Press Enter to connect this provider.',
            status,
            action: { type: 'provider', provider: name },
          };
        });
        dispatch({
          type: 'picker',
          picker: {
            kind: 'providers',
            title: 'Model providers',
            subtitle: state.provider
              ? `Active: ${providerManager.getProviderDisplayName(state.provider)}`
              : 'No provider selected yet.',
            items,
          },
        });
        return true;
      }

      case 'models': {
        dispatch({ type: 'phase', phase: 'Importing local agent models…' });
        await providerManager.warmLocalModels();
        dispatch({ type: 'phase', phase: 'Ready' });
        const entries = Array.from(providerManager.getVisibleProviders().entries());
        entries.sort((a, b) => {
          if (a[0] === state.provider) return -1;
          if (b[0] === state.provider) return 1;
          return 0;
        });
        const items: PickerItem[] = entries.flatMap(([name, provider]) => {
          const connected = providerManager.isConfigured(name);
          return providerManager.getModelsFor(name).map((model): PickerItem => {
            const active = name === state.provider && provider.config.model === model;
            return {
              id: `model:${name}:${model}`,
              label: model,
              meta: `${name} · ${provider.config.displayName} · ${
                providerManager.isLocalAgentName(name)
                  ? connected ? 'local CLI' : 'local CLI · missing'
                  : name === 'ollama'
                    ? 'local'
                    : connected ? 'connected' : 'not connected'
              }`,
              detail: active
                ? 'Currently active.'
                : connected
                  ? 'Press Enter to use this model.'
                  : 'Press Enter to connect this provider.',
              status: active ? 'active' : connected ? 'connected' : 'offline',
              action: { type: 'model', provider: name, model },
            };
          });
        });
        const localCount = ['opencode', 'pi'].reduce(
          (sum, name) => sum + Math.max(0, providerManager.getModelsFor(name as ProviderName).length - 1),
          0
        );
        dispatch({
          type: 'picker',
          picker: {
            kind: 'models',
            title: 'Models',
            subtitle: [
              state.provider
                ? `Active provider: ${providerManager.getProviderDisplayName(state.provider)}`
                : 'Select a model to activate its provider.',
              localCount > 0 ? `${localCount} local model(s) imported` : '',
            ].filter(Boolean).join(' · '),
            empty: 'No models available.',
            items,
          },
        });
        return true;
      }

      case 'model':
      case 'switch': {
        const value = rest.trim();
        if (!value) {
          const active = state.provider;
          addSystem(active
            ? `Active: ${providerManager.getProviderDisplayName(active)} · ${providerManager.getProvider(active)?.config.model}`
            : 'No active model. Use /login to connect a provider.', 'model');
          return true;
        }

        const provider = providerManager.resolveProviderName(value);
        if (provider) {
          if (providerManager.isProviderDisabled(provider)) {
            addSystem(`${providerManager.getProviderDisplayName(provider)} is disabled. Enable it in ~/.config/mad-harness/config.json first.`, 'model');
            return true;
          }
          const connected = providerManager.isConfigured(provider);
          if (!connected) {
            addSystem(`${provider} is not connected. Run /login ${provider} or /login and paste its key.`, 'model');
            return true;
          }
          providerManager.setActiveProvider(provider);
          dispatch({ type: 'provider', provider });
          addSystem(`Active provider: ${providerManager.getProviderDisplayName(provider)} · ${providerManager.getProvider(provider)?.config.model}`, 'model');
          return true;
        }

        dispatch({ type: 'phase', phase: 'Importing local agent models…' });
        await providerManager.warmLocalModels();
        dispatch({ type: 'phase', phase: 'Ready' });
        const modelMatches = Array.from(providerManager.getVisibleProviders().entries()).flatMap(([name, config]) =>
          providerManager.getModelsFor(name)
            .filter((model) => model.toLowerCase() === value.toLowerCase())
            .map((model) => ({ provider: name, model }))
        );

        const active = state.provider;
        const activeMatch = active ? modelMatches.find((match) => match.provider === active) : undefined;
        const match = activeMatch ?? (modelMatches.length === 1 ? modelMatches[0] : undefined);

        if (match) {
          const connected = providerManager.isConfigured(match.provider);
          if (!connected) {
            addSystem(`${match.provider} is not connected. Run /login ${match.provider}.`, 'model');
            return true;
          }
          providerManager.setModel(match.provider, match.model);
          providerManager.setActiveProvider(match.provider);
          dispatch({ type: 'provider', provider: match.provider });
          addSystem(`Active model: ${providerManager.getProviderDisplayName(match.provider)} · ${match.model}`, 'model');
          return true;
        }

        if (modelMatches.length > 1) {
          const providers = [...new Set(modelMatches.map((entry) => entry.provider))].join(', ');
          addSystem(`Model "${value}" is offered by ${providers}. Pick it from /models or run /model <provider> first.`, 'model');
          return true;
        }

        if (!active) {
          addSystem('No active provider. Use /login before choosing a model.', 'model');
          return true;
        }
        providerManager.setModel(active, value);
        addSystem(`Active model: ${providerManager.getProviderDisplayName(active)} · ${value}`, 'model');
        return true;
      }

      case 'status': {
        const plan = state.plan;
        const finished = plan?.tasks.filter((task) => task.status === 'done').length ?? 0;
        const rows = [
          `Model:      ${state.provider ? providerManager.getProviderDisplayName(state.provider) : '(none)'}`,
          `Workspace:  ${state.cwd}`,
          `Branch:     ${state.branch || '(detached)'}`,
          `Tokens:     ${state.tokens.toLocaleString()} (${Object.entries(state.providerUsage).map(([name, count]) => `${name} ${count.toLocaleString()}`).join(' · ') || 'none yet'})`,
          `Plan:       ${plan ? `${finished}/${plan.tasks.length} tasks complete` : '(no active plan)'}`,
          `Approvals:  ${allowAlways.current.size} always-allow rule(s)`,
          `Session:    ${formatElapsed(state.sessionStart)}`,
        ];
        addSystem(rows.join('\n'), 'status');
        return true;
      }

      case 'plan':
        addSystem(state.plan ? planText(state.plan) : 'No plan yet. Send a task first.', 'plan');
        return true;

      case 'agents': {
        if (state.agentOrder.length === 0) {
          const items: PickerItem[] = AGENT_ROLE_INFO.map((info): PickerItem => ({
            id: `role:${info.role}`,
            label: info.label,
            meta: `${info.role} · idle · no run yet`,
            detail: info.detail,
            status: 'idle',
            action: { type: 'role', role: info.role },
          }));
          dispatch({
            type: 'picker',
            picker: {
              kind: 'agents',
              title: 'Agents',
              subtitle: 'No workers yet this session. Browse the roles the supervisor can spawn.',
              items,
            },
          });
          return true;
        }

        const items: PickerItem[] = state.agentOrder.flatMap((id): PickerItem[] => {
          const agent = state.agents[id];
          if (!agent) return [];
          const elapsed = formatElapsed(agent.startedAt, agent.endedAt);
          return [{
            id: `agent:${agent.id}`,
            label: `${agent.role} · ${agent.title}`,
            meta: [
              agent.status,
              agent.provider,
              agent.tokens ? `${agent.tokens.toLocaleString()} tok` : '',
              elapsed,
            ].filter(Boolean).join(' · '),
            detail: agent.current || agent.summary || 'No output yet.',
            status: pickerStatus(agent.status),
            action: { type: 'agent' as const, agentId: agent.id },
          }];
        });
        dispatch({
          type: 'picker',
          picker: {
            kind: 'agents',
            title: 'Agents',
            subtitle: `${items.length} worker${items.length === 1 ? '' : 's'} in this session.`,
            items,
          },
        });
        return true;
      }

      case 'diff': {
        const diff = await gitTool.getDiff();
        dispatch({ type: 'entry', entry: transcriptEntry('diff', diff.output || '(no diff)', { title: 'git diff' }) });
        return true;
      }

      case 'distill':
      case 'compare':
      case 'benchmark': {
        const file = rest || 'benchmark_large.py';
        const abs = path.resolve(state.cwd, file);
        if (!fs.existsSync(abs)) {
          addSystem(`File not found: ${file}`, 'distill');
          return true;
        }
        try {
          const content = fs.readFileSync(abs, 'utf-8');
          const distilled = distillSource(abs, content, state.cwd);
          addSystem([
            `${distilled.relativePath} (${distilled.language})`,
            `Original: ${distilled.originalLines} lines · ${distilled.originalTokens.toLocaleString()} tokens`,
            `Contract: ${distilled.distilledLines} lines · ${distilled.distilledTokens.toLocaleString()} tokens`,
            `Saved:    ${distilled.savingsPercent}%`,
            distilled.classes.length ? `Classes:  ${distilled.classes.join(', ')}` : '',
            distilled.functions.length ? `Functions: ${distilled.functions.join(', ')}` : '',
          ].filter(Boolean).join('\n'), 'distill');
        } catch (err) {
          addSystem(`Distill failed: ${err instanceof Error ? err.message : String(err)}`, 'distill');
        }
        return true;
      }

      case 'permissions': {
        if (rest === 'clear') {
          allowAlways.current.clear();
          addSystem('Cleared always-allow rules.', 'permissions');
          return true;
        }
        const keys = [...allowAlways.current];
        addSystem(keys.length ? keys.join('\n') : 'No always-allow rules. Every write and shell command asks first.', 'permissions');
        return true;
      }

      case 'cwd': {
        if (!rest) {
          addSystem(state.cwd, 'workspace');
          return true;
        }
        const target = path.resolve(state.cwd, rest);
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          addSystem(`Not a directory: ${target}`, 'workspace');
          return true;
        }
        process.chdir(target);
        let branch = '';
        try {
          const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: target, timeout: 5000 });
          branch = stdout.trim();
        } catch {
          branch = '';
        }
        dispatch({ type: 'cwd', cwd: target, branch });
        addSystem(`Workspace: ${target}${branch ? ` (${branch})` : ''}`, 'workspace');
        return true;
      }

      default:
        addSystem(`Unknown command: /${command}. Type /help.`, 'command');
        return true;
    }
  }, [state, cancel, login, addSystem, startDag]);

  const submit = useCallback(async (raw: string) => {
    const input = raw.trim();
    if (!input) return;

    if (state.awaitingKey) {
      if (input === '/cancel') {
        dispatch({ type: 'awaitingKey', value: false });
        addSystem('Login cancelled.', 'login');
        return;
      }
      if (input.startsWith('/')) {
        addSystem('Login in progress. Paste an API key, or /cancel.', 'login');
        return;
      }
      const detected = providerManager.detectProviderFromKey(input);
      if (!detected) {
        addSystem('Could not detect a provider from that key. Try /login <provider> instead.', 'login');
        return;
      }
      if (providerManager.isProviderDisabled(detected)) {
        addSystem(`${providerManager.getProviderDisplayName(detected)} is disabled. Enable it in ~/.config/mad-harness/config.json first.`, 'login');
        return;
      }
      providerManager.setApiKey(detected, input);
      dispatch({ type: 'awaitingKey', value: false });
      providerManager.setActiveProvider(detected);
      dispatch({ type: 'provider', provider: detected });
      addSystem(`Detected ${providerManager.getProviderDisplayName(detected)} and connected it (${providerManager.getMaskedKey(detected)}).`, 'login');
      return;
    }

    if (state.awaitingProvider) {
      if (input === '/cancel') {
        dispatch({ type: 'awaiting', provider: null });
        addSystem('Login cancelled.', 'login');
        return;
      }
      if (input.startsWith('/')) {
        addSystem('Login in progress. Paste an API key, or /cancel.', 'login');
        return;
      }
      const provider = state.awaitingProvider;
      if (providerManager.isProviderDisabled(provider)) {
        dispatch({ type: 'awaiting', provider: null });
        addSystem(`${providerManager.getProviderDisplayName(provider)} is disabled. Run: mad config ${provider} --enable`, 'login');
        return;
      }
      providerManager.setApiKey(provider, input);
      dispatch({ type: 'awaiting', provider: null });
      providerManager.setActiveProvider(provider);
      dispatch({ type: 'provider', provider });
      addSystem(`Authenticated ${providerManager.getProviderDisplayName(provider)} (${providerManager.getMaskedKey(provider)}).`, 'login');
      return;
    }

    if (input.startsWith('/')) {
      await handleCommand(input);
      return;
    }

    if (busyRef.current) {
      addSystem('An agent run is active. Press Esc to cancel it.', 'busy');
      return;
    }

    if (!state.history.includes(input)) {
      // history is appended inside startRun as well
    }

    await startChat(input);
  }, [state.awaitingProvider, handleCommand, addSystem, startChat]);

  const elapsed = useCallback(() => formatElapsed(state.sessionStart), [state.sessionStart]);

  return {
    state,
    approval,
    submit,
    cancel,
    respondApproval,
    elapsed,
    addSystem,
    inspectAgent,
    inspectRole,
    selectPicker,
    closePicker,
  };
}
