import type { ProviderName } from '../types.js';

export type AgentRole =
  | 'supervisor'
  | 'architect'
  | 'coder'
  | 'verifier'
  | 'researcher'
  | 'debugger';

export type AgentTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanTask {
  id: string;
  role: AgentRole;
  title: string;
  task: string;
  dependsOn: string[];
  writes: boolean;
  status: AgentTaskStatus;
  provider?: ProviderName;
  summary?: string;
  error?: string;
  tokens?: number;
  toolsUsed?: string[];
  startedAt?: number;
  endedAt?: number;
}

export interface AgentPlan {
  mode: 'plan';
  summary: string;
  tasks: PlanTask[];
  acceptance: string[];
}

export interface AnswerPlan {
  mode: 'answer';
  summary: string;
  answer: string;
}

export type SupervisorDecision = AgentPlan | AnswerPlan;

export interface ApprovalRequest {
  id: string;
  tool: string;
  summary: string;
  detail?: string;
  key: string;
}

export type ApprovalDecision = 'once' | 'always' | 'deny';
export type ApproveFn = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export type BusKind =
  | 'plan'
  | 'thought'
  | 'result'
  | 'handoff'
  | 'critique'
  | 'summary'
  | 'note';

export interface BusEntry {
  id: string;
  agentId: string;
  role: AgentRole | 'user';
  kind: BusKind;
  content: string;
  at: number;
}

export type HarnessEvent =
  | { type: 'status'; text: string }
  | { type: 'plan'; plan: AgentPlan }
  | { type: 'agent'; task: PlanTask }
  | { type: 'thinking'; agentId: string; role: AgentRole; text: string }
  | {
      type: 'tool';
      agentId: string;
      role: AgentRole;
      tool: string;
      summary: string;
      status: 'start' | 'ok' | 'error';
      detail?: string;
    }
  | { type: 'bus'; entry: BusEntry }
  | { type: 'tokens'; provider: ProviderName; tokens: number; model?: string }
  | { type: 'diff'; text: string }
  | { type: 'assistant'; content: string }
  | { type: 'error'; message: string };

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  provider: ProviderName | null;
  approve: ApproveFn;
  onEvent: (event: HarnessEvent) => void;
  signal?: AbortSignal;
  maxRounds?: number;
  maxSteps?: number;
  allowAlways?: Set<string>;
}

export interface AgentRunResult {
  ok: boolean;
  content: string;
  plan?: AgentPlan;
  tasks: PlanTask[];
  tokens: number;
  providers: ProviderName[];
  duration: number;
  changedFiles: string[];
}

export interface WorkerResult {
  ok: boolean;
  summary: string;
  tokens: number;
  provider: ProviderName;
  toolsUsed: string[];
  changedFiles: string[];
  error?: string;
}

export interface ToolOutcome {
  ok: boolean;
  output: string;
  changedFiles?: string[];
  data?: unknown;
}
