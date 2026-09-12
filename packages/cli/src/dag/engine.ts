import type {
  DAGNodeConfig,
  DAGExecutionResult,
  DAGEventHandler,
  DAGNodeState,
  DAGExecutionState,
  DAGEvent,
  AgentExecutor,
  AgentResult,
  AgentRole,
} from './types.js';

// ─── DAG Execution Engine ───────────────────────────────────────────────────
//
// Executes a linear pipeline of agent nodes with:
//   - Sequential execution respecting dependency order
//   - Circuit breaker: configurable max retries per node
//   - Event emission for real-time progress tracking
//   - Context passing between nodes (each node's output feeds the next)
//   - Timeout enforcement per node
// ─────────────────────────────────────────────────────────────────────────────

export class DAGEngine {
  private nodes: Map<AgentRole, DAGNodeState> = new Map();
  private pipeline: DAGNodeConfig[];
  private handlers: Set<DAGEventHandler> = new Set();
  private state: DAGExecutionState = 'IDLE';

  constructor(pipeline: DAGNodeConfig[]) {
    this.pipeline = pipeline;
    this.reset();
  }

  /** Register an event handler for DAG execution events */
  public on(handler: DAGEventHandler): void {
    this.handlers.add(handler);
  }

  /** Remove an event handler */
  public off(handler: DAGEventHandler): void {
    this.handlers.delete(handler);
  }

  /** Get the current state of all nodes */
  public getNodes(): Map<AgentRole, DAGNodeState> {
    return new Map(this.nodes);
  }

  /** Get the current execution state */
  public getState(): DAGExecutionState {
    return this.state;
  }

  /** Reset all nodes to PENDING */
  public reset(): void {
    this.nodes.clear();
    this.state = 'IDLE';
    for (const config of this.pipeline) {
      this.nodes.set(config.role, {
        config,
        state: 'PENDING',
        retryCount: 0,
      });
    }
  }

  /**
   * Execute the full DAG pipeline.
   *
   * @param input - The initial input (e.g., pruned AST content)
   * @param executor - Function that runs each agent
   * @returns Execution result with all node results and timing
   */
  public async execute(
    input: string,
    executor: AgentExecutor
  ): Promise<DAGExecutionResult> {
    this.reset();
    this.state = 'RUNNING';
    const context: Record<string, string> = { input };
    const results: Record<string, AgentResult> = {};
    const startTime = Date.now();
    let totalRetries = 0;

    for (const config of this.pipeline) {
      const nodeState = this.nodes.get(config.role)!;
      let success = false;
      nodeState.startTime = new Date();
      nodeState.retryCount = 0;

      while (nodeState.retryCount <= config.maxRetries && !success) {
        // Emit start/retry event
        this.emit({
          type: nodeState.retryCount > 0 ? 'node_retry' : 'node_start',
          role: config.role,
          message: nodeState.retryCount > 0
            ? `⟳ Retrying ${config.displayName} (attempt ${nodeState.retryCount + 1}/${config.maxRetries + 1})`
            : `▶ Starting ${config.displayName}`,
        });

        nodeState.state = 'RUNNING';

        try {
          // Race the executor against the timeout
          const timeoutPromise = new Promise<AgentResult>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${config.timeoutMs}ms`)), config.timeoutMs)
          );

          const result = await Promise.race([
            executor(config.role, input, context),
            timeoutPromise,
          ]);

          result.retryCount = nodeState.retryCount;
          nodeState.result = result;

          if (result.state === 'PASSED') {
            success = true;
            nodeState.state = 'PASSED';
            nodeState.endTime = new Date();
            results[config.role] = result;
            context[config.role] = result.output;

            this.emit({
              type: 'node_complete',
              role: config.role,
              data: result,
              message: `✓ ${config.displayName} completed (${result.duration}ms)`,
            });
          } else {
            nodeState.state = 'FAILED';
            nodeState.retryCount++;
            totalRetries++;

            this.emit({
              type: 'node_failed',
              role: config.role,
              data: result,
              message: `✗ ${config.displayName} failed: ${result.error ?? 'unknown error'}`,
            });

            if (nodeState.retryCount < config.maxRetries) {
              const waitMs = Math.min(3000 * nodeState.retryCount, 8000);
              await new Promise(resolve => setTimeout(resolve, waitMs));
            }
          }
        } catch (error) {
          nodeState.state = 'FAILED';
          const errorMsg = error instanceof Error ? error.message : String(error);
          const failedResult: AgentResult = {
            role: config.role,
            state: 'FAILED',
            output: '',
            duration: Date.now() - nodeState.startTime.getTime(),
            retryCount: nodeState.retryCount,
            error: errorMsg,
          };
          nodeState.result = failedResult;
          nodeState.retryCount++;
          totalRetries++;

          this.emit({
            type: 'node_failed',
            role: config.role,
            data: failedResult,
            message: `✗ ${config.displayName} error: ${errorMsg}`,
          });
        }
      }

      if (!nodeState.endTime) {
        nodeState.endTime = new Date();
      }

      // Circuit breaker: halt if node exhausted all retries
      if (!success) {
        this.state = 'FAILED';
        const errorMsg = `Pipeline halted at ${config.displayName} after ${nodeState.retryCount} attempts (circuit breaker triggered)`;

        // Mark remaining nodes as SKIPPED
        let skip = false;
        for (const cfg of this.pipeline) {
          if (skip) {
            const skippedNode = this.nodes.get(cfg.role)!;
            skippedNode.state = 'SKIPPED';
          }
          if (cfg.role === config.role) skip = true;
        }

        this.emit({
          type: 'dag_failed',
          message: errorMsg,
        });

        return {
          state: this.state,
          results,
          totalDuration: Date.now() - startTime,
          totalRetries,
          error: errorMsg,
        };
      }
    }

    this.state = 'COMPLETED';
    this.emit({
      type: 'dag_complete',
      message: '✅ Pipeline completed successfully',
    });

    return {
      state: this.state,
      results,
      totalDuration: Date.now() - startTime,
      totalRetries,
    };
  }

  /** Emit a DAGEvent to all registered handlers */
  private emit(event: Omit<DAGEvent, 'timestamp'>): void {
    const fullEvent: DAGEvent = { ...event, timestamp: new Date() };
    for (const handler of this.handlers) {
      try {
        handler(fullEvent);
      } catch (err) {
        // Don't let handler errors crash the pipeline
        console.error('Error in DAG event handler:', err);
      }
    }
  }
}
