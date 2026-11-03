# MAD harness architecture

MAD uses a shared operation/event protocol with a session core and thin terminal and CLI adapters. It combines that structure with AST contract distillation, named agents, and a DAG that is created **after** planning.

The terminal uses a main transcript for messages, tool activity and agent streams, plus an agent activity panel on wide terminals. `/agents` opens detailed inspection in the main view. See [the architecture comparison](docs/ARCHITECTURE_COMPARISON.md) for the Codex patterns reviewed and the MAD-owned DAG, AST and token-budget boundaries.

## Using the harness

```sh
npm run build
npm run mad -- --help
npm run mad                         # interactive terminal
npm run mad -- "fix failing tests" # execute directly
npm run mad -- ask "explain this"  # direct provider answer
npm run mad -- pipeline benchmark_large.py --dry-run
```

Ordinary messages and tasks run directly through the tool loop. Planning is opt-in: `/plan <task>` generates a plan without executing it, and `/run` executes the prepared plan through the DAG. `/run <task>` is an alias for direct execution. The DAG enforces dependencies and checks only when you choose to use a plan.

```text
/plan implement pagination
/run
/permissions
/permissions ask
/permissions full
/agent backend coder
/task backend inspect the API and implement pagination
/agent tests verifier
/task tests check pagination edge cases
/agents
/stop backend
/dag
/resume
/resume <session-id>
```

`/agent <name> [role] [task]` creates a named agent. `/task <name> <task>` and `/message <name> <text>` assign work. Separate named agents can run independent tasks. Submitting overlapping work to the same agent returns an error. `/plan <task>` creates a plan, `/run` executes it, and `/run <task>` runs directly; `/dag` displays the current graph. Esc cancels work. The composer remains available while work runs; new messages steer the direct agent loop between sampling steps.

Use `/providers`, `/models`, `/model <provider> [model]`, `/login [provider]`, `/permissions`, `/compact`, `/diff`, `/distill <file>`, and `/status` to inspect or configure the session.

## Source map

| Directory | Responsibility |
| --- | --- |
| `protocol/` | Typed operations, events, tool specifications, approval decisions |
| `session/` | Turn lifecycle, steering, approval queue, history, provider selection, MCP lifecycle |
| `agents/` | Named agents, cancellation, planning and DAG execution |
| `dag/` | Dependency scheduling, validation, retries and observable node states |
| `agent/` | Planning, worker loop, prompts and AST context collection |
| `tools/` | Tool registry, runtimes and persisted approval rules |
| `mcp/` | Stdio JSON-RPC client and deferred tool discovery |
| `tokens/` | History, output and deferred-schema budgets plus labelled usage estimates |
| `rollout/` | Append-only JSONL recording and conversation replay |
| `hooks/`, `components/`, `commands/` | Terminal and headless adapters |

## Configuration and token budgets

Configuration loads from `~/.mad/config.json`, then the workspace's `.mad/config.json`, then CLI overrides. Set `MAD_HOME` to isolate configuration, credentials, permissions and sessions for testing. Without `MAD_HOME`, provider credentials continue to use the existing Conf store.

Providers must be listed in `enabledProviders`. Defaults enable the cloud-backed OpenCode and Pi adapters. Ollama is optional and is not probed during cloud-mode startup or status checks. Use `mad auth <provider>` and `mad config <provider> --enable` for a hosted provider. `defaultModel` applies to the selected provider. Fallback selects an available enabled provider before sampling; it does not replay failed remote requests through another provider.

Casual standalone messages such as `hi`, `hii`, `helloo`, and `hmm` (including repeated letters and punctuation) are answered locally with zero model calls and zero model tokens, even when entered rapidly. A greeting followed by an actual task still reaches the agent. Local exchanges stay in the transcript and rollout but are omitted from later model requests. Normal tasks do not preload repository trees or AST contracts: project instructions stay in the prompt, and the agent fetches additional code context through read/search tools or `repo_context` only when needed. Named agents use the same lazy context strategy. AST distillation reduces requested repository context. Simple standalone clone requests execute `git_clone` directly, without a model call, and verify the resulting working tree. Conceptual questions use a compact prompt with no tool schemas. Native tool call IDs and results remain paired across OpenAI-compatible, Anthropic, and Gemini requests, history budgeting, and replay. `contextCharBudget`, `toolOutputCharCap`, `maxStepsPerTask`, `verifyRounds`, and `autoCompaction` control context retention and work limits. Worker history preserves the task and newest results within a character budget after reserving space for instructions and tool schemas. Large tool results are shortened; native call/result groups remain intact. Mutating tools from named agents sharing a workspace run under a shared lock. The footer shows tokens for the current turn; `/status` separates last-turn and session totals. Provider totals are not reused as output counts. Counts derived from text are marked as estimates, not measured billing savings.

MCP tools enter the registry as deferred tools. A small `tool_search` schema is offered initially; matching schemas are exposed on demand, at most five per search. MCP calls request approval because server tools can mutate external state. Configured MCP servers use stdio transport.

## Streaming and action execution

OpenCode uses a password-protected local `serve` process and `/event` SSE subscription so text deltas reach the terminal before the response finishes. The CLI and TUI both consume these deltas, including incremental decoding of text-provider JSON summaries. OpenCode’s own tools are disabled: MAD performs filesystem and shell operations through its permission gate. Provider processes close with the session. `MAD_OPENCODE_TRANSPORT=run` retains the older buffered CLI transport for compatibility; it cannot guarantee incremental output.

A standalone `clone <repository URL> [into <destination>]` request bypasses the model and runs the verified clone tool. Compound cloning requests use the full agent loop. Explicit action requests that produce only instructions receive one bounded correction; without an actual successful tool action they end as incomplete, not successful. Tool failures and approval denials remain incomplete. This does not make MAD feature-identical to Codex or guarantee identical model behavior.

## Permissions and terminal behavior

`/permissions` opens a choice between Ask permission and Full access. `/permissions ask` requires approval for every mutating action and confines file tools to the workspace. `/permissions full` auto-approves actions and allows file tools outside the workspace for the current session. Shell commands use the host user’s permissions. CLI equivalents are `--ask-permission` and `--full-access`; `--yes` auto-approves workspace actions without widening file access. `--plan` prints a plan without executing it.

The terminal reserves a spare row and column to avoid Ink’s full-screen clear path. Idle rendering has no timer, streamed text is batched, and long approval details have bounded, scrollable pages.

## Persistence and verification

Sessions append metadata and conversation items beneath `~/.mad/sessions/`. Compaction and clear operations record replacement history snapshots so replay does not restore discarded conversation. `/resume <id>` loads conversation history into the current workspace session; it does not restart in-flight processes or reconstruct running agent/DAG state. Closing a session cancels outstanding work, waits for workers to settle, and fsyncs the rollout file. Credentials under MAD_HOME live in credentials.json, separately from layered configuration.

A worker succeeds only after explicit completion; exhaustion and cancellation remain incomplete. Verifiers must return a structured `pass: true` verdict with an issues array. DAGs reject duplicate IDs, missing dependencies, and cycles before execution. A failed workflow can invoke a debugger and rerun the failed node for verification.

Run `npm run typecheck`, `npm test`, and `npm run build`. The tests use scripted providers and a local MCP fixture, covering dependency ordering, retries, cancellation, worker limits, verifier verdicts, named agents, replay, configuration, and deferred discovery. The suite also launches the CLI with a local provider fixture to verify file writes, approval denial, exit status, and rollout persistence. The terminal was manually checked in a PTY for startup, agent commands, and clean exit. Live provider credentials and network behavior remain untested. Shell commands run with the host user’s permissions; approval gating is not an OS sandbox. This is an integration of MAD's architecture, not complete feature parity with Codex.
