# Codex patterns and MAD-owned extensions

Reference sources reviewed:

- [Codex operation/event protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
- [Codex session core](https://github.com/openai/codex/tree/main/codex-rs/core/src/session)
- [Codex terminal application](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app.rs)
- [Codex local-provider discovery](https://github.com/openai/codex/blob/main/codex-rs/ollama/src/client.rs)

MAD follows the architectural separation between operations, a session core, provider requests, tool execution and events consumed by terminal clients. This comparison does not assert complete Codex feature or model-quality parity.

| Boundary | MAD implementation |
| --- | --- |
| Submit input and consume events | `protocol/types.ts`, `session/session.ts` |
| Foreground and worker sampling | `agent/step.ts` normalizes native/text tool calls, streams human-readable text and records usage consistently |
| Provider transports | `providers/client.ts`, `providers/opencode-events.ts`, `providers/local-agent.ts` |
| Approvals and execution | `tools/registry.ts`, `tools/approvals.ts`, workspace mutation lock and tool runtimes |
| Persistence and resume | Typed rollout records and replacement history snapshots |
| Terminal presentation | Main transcript and composer, plus a read-only agent activity panel on wide terminals |

The inference path is:

```text
User input → Op → MadSession → sampleStep → ProviderClient
                                  ↓
                              ToolRegistry → tool result → next step
                                  ↓
                         Event stream → main transcript
```

`/agents` opens an agent picker in the main view. Selecting an entry shows its task, status and output in the transcript. `/agent <existing-name>` and `/agents <name>` inspect directly. The panel shows active agents, their latest tool activity, and actual DAG dependency handoffs; the transcript retains the full handoff text. Narrow terminals show the agent count in the status line and use the transcript for details. The panel does not take keyboard focus.

## MAD-owned behavior

Planning is opt-in with `/plan`; `/run` executes that prepared plan. Ordinary tasks use the direct execution loop. The DAG is compiled after planning and monitors dependencies, attempts, failures and verification. AST contracts are retrieved through `distill_file` and `repo_context` only when relevant.

Token management remains MAD-specific:

- Standalone casual messages and simple verified clone requests need no inference.
- Conceptual questions omit tool schemas and repository context.
- Project instructions remain available; source bodies are fetched lazily with targeted line reads.
- Model history excludes local casual exchanges but rollouts retain the complete transcript.
- Native calls/results are kept together when fitting history to a request budget.
- Deferred schemas are exposed on demand. At most five discovered schemas are advertised at once, with a 6,000-character target for those schemas; registered runtimes remain callable. The most recently requested schema is retained even if it alone exceeds that target. Foreground task boundaries reset discovery when no named workers are running.
- System instructions do not repeat tool names, keeping the system prefix stable as discovery changes.
- Usage comes from provider counters when available; fallback estimates remain labelled. No display counter is fabricated to meet a token target.
- Each foreground turn and named-agent, DAG-node, repair or verifier worker has a configurable `agentTaskTokenBudget` (default 30,000 input plus output tokens per invocation). Before a model call it estimates the request with a 25% margin, reserves at least 128 output tokens, and reduces the requested output limit to the remainder. Reported usage is charged after each call; otherwise the estimate is used. If another useful call cannot fit, the task reports incomplete work. The limit is a best-effort guard, not a billing guarantee: tokenizers differ, some providers or CLI proxies may ignore output limits, and automatic compaction is charged after its call. A whole DAG may run multiple workers; planning has separate limits.

Cloud-backed execution is the default. Optional local-provider support stays behind its adapter and explicit selection. Cloud startup, provider browsing and status do not probe Ollama. No model downloads or daemon changes are performed.

Checks cover native provider serialization, real Git execution, streamed output before completion, cancellation, permission denial, history replay, schema exposure budgets, and narrow/wide terminal rendering. These establish behavior on the tested paths; they do not establish equal results across different models or equal token charges across providers.
