// ─── Message Types ──────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system' | 'error';

export interface ToolCallInfo {
  name: string;
  args?: string;
  result?: string;
  status?: 'running' | 'success' | 'error';
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  provider?: string;
  model?: string;
  timestamp: Date;
  tokens?: number;
  claudeCodeTokens?: number;
  tokenSavingsPercent?: number;
  latency?: number;
  thought?: string;
  toolCalls?: ToolCallInfo[];
}

// ─── Provider Types ─────────────────────────────────────────────────────────

export type ProviderName = 'claude' | 'codex' | 'groq' | 'ollama' | 'gemini' | 'opencode' | 'pi';

export interface ProviderConfig {
  name: ProviderName;
  displayName: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  isAvailable: boolean;
  maxTokens: number;
}

export type ProviderStatus = 'connected' | 'disconnected' | 'error';

export interface ProviderState {
  config: ProviderConfig;
  status: ProviderStatus;
  lastUsed?: Date;
  totalTokens: number;
}

// ─── DAG Types ──────────────────────────────────────────────────────────────

// MAD is NOT a linear chain: agents share a Mesh Bus (blackboard).
// Phases below are bus participants, not a waterfall.
export type DAGPhase = 'distill' | 'architect' | 'coder' | 'verifier';
// Back-compat aliases from the old linear pipeline naming:
export type LegacyDAGPhase = 'ast-intake' | 'debugger';
export type DAGStatus = 'pending' | 'running' | 'passed' | 'failed' | 'halted';

export interface DAGNode {
  phase: DAGPhase;
  displayName: string;
  status: DAGStatus;
  progress?: string;
  details: string[];
  startTime?: Date;
  endTime?: Date;
}

// ─── App State Types ────────────────────────────────────────────────────────

// Three pillars — this is what makes MAD different from Lightning Harness:
//   distill → token-reducing AST contract engine
//   mesh    → agent communication bus (blackboard, handoffs, shared context)
//   fabric  → multi-provider router (fan-out, fallback, cost-aware)
export type AppView = 'chat' | 'distill' | 'mesh' | 'fabric' | 'benchmark' | 'dag' | 'tools' | 'providers' | 'help' | 'config';

export interface TokenUsage {
  used: number;
  claudeCodeEquivalent: number;
  budget: number;
}

export interface MADState {
  messages: Message[];
  currentProvider: ProviderName | null;
  awaitingLoginProvider: ProviderName | null;
  tokenUsage: TokenUsage;
  isProcessing: boolean;
  dagNodes: DAGNode[];
  error: string | null;
  sessionStartTime: Date;
  view: AppView;
  providers: Map<ProviderName, ProviderState>;
  inputHistory: string[];
  historyIndex: number;
}

// ─── Action Types ───────────────────────────────────────────────────────────

export type MADAction =
  | { type: 'ADD_MESSAGE'; payload: Message }
  | { type: 'SET_PROCESSING'; payload: boolean }
  | { type: 'SET_PROVIDER'; payload: ProviderName | null }
  | { type: 'SET_AWAITING_LOGIN'; payload: ProviderName | null }
  | { type: 'UPDATE_TOKENS'; payload: { used: number; claudeCodeEquivalent?: number } }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_VIEW'; payload: AppView }
  | { type: 'UPDATE_DAG_NODE'; payload: { phase: DAGPhase; updates: Partial<DAGNode> } }
  | { type: 'RESET_DAG' }
  | { type: 'ADD_TO_HISTORY'; payload: string }
  | { type: 'SET_HISTORY_INDEX'; payload: number }
  | { type: 'UPDATE_PROVIDER_STATUS'; payload: { name: ProviderName; status: ProviderStatus } }
  | { type: 'BLOCK_PROVIDER'; payload: ProviderName }
  | { type: 'CLEAR_MESSAGES' };

// ─── Command Parsing ────────────────────────────────────────────────────────

export interface ParsedCommand {
  type: 'provider_message' | 'switch' | 'status' | 'config' | 'connect' | 'keys' | 'login' | 'block' | 'help' | 'exit' | 'plain_message' | 'dag' | 'clear' | 'tools' | 'jira' | 'git' | 'mcp' | 'benchmark' | 'compare' | 'distill';
  provider?: ProviderName;
  args?: string;
  key?: string;
}

// ─── Provider Response ──────────────────────────────────────────────────────

export interface ProviderResponse {
  content: string;
  tokens: number;
  model: string;
  provider: ProviderName;
}
