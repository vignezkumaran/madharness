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
  latency?: number;
  thought?: string;
  toolCalls?: ToolCallInfo[];
}

// ─── Provider Types ─────────────────────────────────────────────────────────

export type ProviderName = 'claude' | 'codex' | 'groq' | 'ollama' | 'gemini';

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

export type DAGPhase = 'ast-intake' | 'architect' | 'coder' | 'debugger';
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

export type AppView = 'chat' | 'providers' | 'dag' | 'help' | 'config' | 'tools';

export interface TokenUsage {
  used: number;
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
  | { type: 'UPDATE_TOKENS'; payload: { used: number } }
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
  type: 'provider_message' | 'switch' | 'status' | 'config' | 'connect' | 'keys' | 'login' | 'block' | 'help' | 'exit' | 'plain_message' | 'dag' | 'clear' | 'tools' | 'jira' | 'git' | 'mcp';
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
