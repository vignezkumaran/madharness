// ─── DAG Types ──────────────────────────────────────────────────────────────

/** Node execution states */
export type NodeState = 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED';

/** Agent role names */
export type AgentRole = 'architect' | 'coder' | 'sandbox' | 'debugger';

/** Result from an agent execution */
export interface AgentResult {
  role: AgentRole;
  state: NodeState;
  output: string;
  artifacts?: Record<string, string>;
  duration: number; // ms
  retryCount: number;
  error?: string;
}

/** Configuration for a DAG node */
export interface DAGNodeConfig {
  role: AgentRole;
  displayName: string;
  maxRetries: number;
  timeoutMs: number;
  dependsOn: AgentRole[];
}

/** Runtime state of a DAG node */
export interface DAGNodeState {
  config: DAGNodeConfig;
  state: NodeState;
  result?: AgentResult;
  startTime?: Date;
  endTime?: Date;
  retryCount: number;
}

/** Overall DAG execution state */
export type DAGExecutionState = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'HALTED';

/** Event emitted during DAG execution */
export interface DAGEvent {
  type: 'node_start' | 'node_complete' | 'node_failed' | 'node_retry' | 'dag_complete' | 'dag_failed';
  role?: AgentRole;
  data?: AgentResult;
  timestamp: Date;
  message: string;
}

/** Handler for DAG events */
export type DAGEventHandler = (event: DAGEvent) => void;

/** Result from a full DAG execution */
export interface DAGExecutionResult {
  state: DAGExecutionState;
  results: Record<string, AgentResult>;
  totalDuration: number;
  totalRetries: number;
  error?: string;
}

/** Agent executor function signature — injected into the DAG engine */
export type AgentExecutor = (
  role: AgentRole,
  input: string,
  context: Record<string, string>
) => Promise<AgentResult>;
