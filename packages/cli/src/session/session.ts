// ─── Session: Op/Event two-channel core with steering + approvals ───────────
import { executionIntent, explanationOnly } from './intent.js';
import { cloneRequest } from '../tools/clone.js';
import {sampleStep} from '../agent/step.js';
import { randomUUID } from 'crypto';
import { smallTalkReply, taskHistory } from './smalltalk.js';
import * as fs from 'fs';
import * as path from 'path';
import type { Event, Op, ResponseItem, ReviewDecision } from '../protocol/types.js';
import { workspaceGuidance } from '../agent/guidance.js';
import { parseAgentReply } from '../agent/protocol.js';
import { compileSystemPrompt } from '../agent/prompts.js';
import { collectRepoContext, type RepoContext } from '../agent/context.js';
import { AgentManager } from '../agents/manager.js';
import { ContextManager } from './context.js';
import { buildProviderClient, fallbackChain, getModelFor, PROVIDERS, type ProviderName } from '../providers/manager.js';
import type { LlmRequest, LlmResult, ProviderClient } from '../providers/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { BUILTIN_TOOLS } from '../tools/builtin.js';
import { computeRequirement, ApprovalStore } from '../tools/approvals.js';
import { classifyRiskSafe } from './approval-bridge.js';
import type { ApprovalRequestBrief } from '../tools/types.js';
import { estimateTokens, UsageLedger } from '../tokens/estimator.js';
import { RolloutRecorder } from '../rollout/recorder.js';
import type { MadConfig } from '../config/loader.js';
import { replayResponseItems } from '../rollout/store.js';
import { McpManager } from '../mcp/manager.js';
import { budgetMessages, reserveTaskTokens } from '../tokens/budget.js';
import { renderMessages } from '../providers/types.js';
type Listener = (event: Event) => void;
const MAX_TOOL_CONTINUATIONS = 6;
export interface SessionOptions {
    workspace: string;
    config: MadConfig;
    provider?: string;
    model?: string;
    rollout?: RolloutRecorder;
}
export class MadSession {
    readonly id = randomUUID();
    readonly workspace: string;
    config: MadConfig;
    readonly context = new ContextManager();
    readonly registry = new ToolRegistry();
    readonly rollouts: RolloutRecorder;
    readonly ledger = new UsageLedger();
    private readonly listeners = new Set<Listener>();
    private readonly approvals = new Map<string, {
        resolve: (decision: ReviewDecision) => void;
    }>();
    private readonly steerQueue: string[] = [];
    private readonly modelClients = new Map<string, ProviderClient>();
    private providerClient: ProviderClient | null = null;
    private providerName: string;
    private readonly selectedModels = new Map<string, string>();
    private abort: AbortController = new AbortController();
    private busy = false;
    private closed = false;
    private readonly jobs = new Set<Promise<unknown>>();
    private toolsStart: Promise<void> | null = null;
    private readonly mcp = new McpManager();
    private mcpReady = false;
    private rolloutStart: Promise<void> | null = null;
    private localApprovalStore = new ApprovalStore();
    private repoContext: RepoContext | null = null;
    constructor(options: SessionOptions) {
        this.workspace = path.resolve(options.workspace);
        if (!fs.statSync(this.workspace).isDirectory())
            throw new Error('Workspace must be a directory');
        this.config = structuredClone(options.config);
        if (options.model)
            this.config.defaultModel = options.model;
        this.rollouts = options.rollout ?? new RolloutRecorder();
        if (options.provider && !PROVIDERS.order.includes(options.provider as never))
            throw new Error(`Unknown provider: ${options.provider}`);
        if(options.provider&&!this.config.enabledProviders.includes(options.provider))this.config.enabledProviders.push(options.provider);
        this.providerName = options.provider ?? this.config.defaultProvider;
        if (this.config.defaultModel) this.selectedModels.set(this.providerName, this.config.defaultModel);
        this.localApprovalStore.load();
        for (const tool of BUILTIN_TOOLS)
            this.registry.register(tool);
        this.registry.register({ spec: { name: 'tool_search', description: 'Find deferred MCP tools by name or description and expose their schemas for subsequent calls.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, exposure: 'direct', readOnly: true, mutates: false }, run: async (args) => {
                const query = String(args.query ?? '').toLowerCase();
                const matches = this.registry.listDeferred().filter(spec => `${spec.name} ${spec.description}`.toLowerCase().includes(query)).slice(0, 5);
                for (const spec of matches)
                    this.registry.expose(spec.name);
                return { ok: true, output: JSON.stringify(matches) };
            } });
    }
    // ─── Event channel ────────────────────────────────────────────────────────
    on(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    private emit(event: Event): void {
        for (const listener of [...this.listeners])
            listener(event);
        this.rollouts?.record(event.kind === 'message-completed' || event.kind === 'tool-completed' || event.kind === 'compacted'
            ? { item: 'event', event: { fine: event.kind, text: 'streamed' + (event.kind === 'message-completed' ? `:${(event as {
                        text: string;
                    }).text.slice(0, 400)}` : ''), at: Date.now() } }
            : { item: 'event', event: { fine: event.kind, text: '', at: Date.now() } });
    }
    note(text: string): void {
        this.emit({ kind: 'note', text });
    }
    // ─── Op submission ────────────────────────────────────────────────────────
    submit(op: Op): void {
        if (this.closed)
            return;
        switch (op.kind) {
            case 'plan-task':
            case 'execute-plan':
                this.runPlanningOp(op);
                return;
            case 'user-message': {
                if (this.busy) {
                    const reply = smallTalkReply(op.text);
                    if (reply) {
                        this.push({ type: 'message', role: 'user', content: op.text });
                        this.push({ type: 'assistant-message', content: reply, toolRuns: [] });
                        this.emit({ kind: 'note', text: reply });
                        return;
                    }
                    this.steerQueue.push(op.text);
                    this.emit({ kind: 'note', text: 'queued — will steer the current turn' });
                    return;
                }
                this.track(this.runUserTurn(op.text).catch((error) => {
                    this.emit({ kind: 'error', message: (error as Error).message });
                    this.emit({ kind: 'turn-ended', ok: false });
                }));
                return;
            }
            case 'steer-message': {
                this.steerQueue.push(op.text);
                return;
            }
            case 'interrupt':
                this.cancel();
                this.emit({ kind: 'note', text: 'interrupt requested' });
                return;
            case 'review': {
                const pending = this.approvals.get(op.id);
                if (pending) {
                    pending.resolve(op.decision);
                }
                return;
            }
            case 'compact':
                if (!this.isBusy())
                    this.track(this.compactNow());
                return;
            case 'clear':
                if (this.isBusy()) {
                    this.note('Interrupt the current turn before clearing.');
                    return;
                }
                this.context.items = [];
                this.rollouts.record({ item: 'history-snapshot', items: [] });
                this.emit({ kind: 'note', text: 'history cleared' });
                return;
            case 'start-dag':
                // Legacy clients still execute directly; planning requires plan-task.
                this.submit({ kind: 'user-message', text: op.goal, workspace: op.workspace, mode: 'agent' });
                return;
            case 'spawn-agent':
            case 'agent-message':
            case 'agent-task':
            case 'stop-agent':
            case 'dag-op':
                this.routeAgentOp(op);
                return;
            default:
                return;
        }
    }
    cancel(): void {
        this.abort.abort(new Error('cancelled'));
        this.steerQueue.length = 0;
        for (const [id, pending] of this.approvals) {
            pending.resolve('denied');
            this.approvals.delete(id);
        }
        this.agentManagerRef?.cancelAll();
    }
    // ─── Agent/DAG routing ────────────────────────────────────────────────────
    private agentManagerRef: AgentManager | null = null;
    agentManager(): AgentManager {
        if (!this.agentManagerRef) {
            this.agentManagerRef = new AgentManager({
                workspace: this.workspace,
                config: this.config,
                tools: () => this.registry.listTools(),
                history: () => renderMessages('', taskHistory(this.context.items)).map(message => message.content).join('\n\n').slice(-this.config.contextCharBudget),
                emit: (event) => {
                    if (event.kind === 'token-usage') {
                        this.recordUsage({ input: event.input, output: event.output, estimated: event.estimated }, 'turn');
                        return;
                    }
                    if (event.kind === 'message-completed')
                        this.push({ type: 'assistant-message', content: event.text, toolRuns: event.toolRuns });
                    this.emit(event);
                },
                client: model => this.clientFor(model),
                requestApproval: (request, signal) => this.requestApproval(request, signal),
                signal: this.abort.signal,
            });
        }
        return this.agentManagerRef;
    }
    private routeAgentOp(op: Extract<Op, {
        kind: 'spawn-agent' | 'agent-message' | 'agent-task' | 'stop-agent' | 'dag-op';
    }>): void {
        if (op.kind === 'dag-op') {
            this.note(JSON.stringify(this.agentManager().activeNodes(), null, 2));
            return;
        }
        if (op.kind === 'stop-agent') {
            this.agentManager().stopAgent(op.name);
            return;
        }
        if (!this.busy && this.abort.signal.aborted)
            this.abort = new AbortController();
        const signal = this.abort.signal;
        this.track((async () => {
            try {
                await this.startRolloutIfNeeded(`Agent operation: ${op.kind}`);
                signal.throwIfAborted();
                await this.prepareTools();
                signal.throwIfAborted();
                const manager = this.agentManager();
                if (op.kind === 'spawn-agent')
                    await manager.createAgent(op);
                else if (op.kind === 'agent-task') {
                    this.push({ type: 'message', role: 'user', content: `Task for ${op.name}: ${op.task}` });
                    await manager.submitTask(op.name, op.task);
                }
                else if (op.kind === 'agent-message') {
                    this.push({ type: 'message', role: 'user', content: `Message for ${op.name}: ${op.text}` });
                    await manager.submitTask(op.name, op.text);
                }
            }
            catch (error) {
                this.emit({ kind: 'error', message: (error as Error).message });
            }
        })());
    }
    private runPlanningOp(op: Extract<Op, {
        kind: 'plan-task' | 'execute-plan';
    }>): void {
        if (this.busy) {
            this.note('Wait for the current turn or cancel it first.');
            return;
        }
        this.busy = true;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        this.emit({ kind: 'turn-started', id: randomUUID() });
        this.emit({ kind: 'activity', phase: op.kind === 'plan-task' ? 'Planning' : 'Working' });
        this.track((async () => {
            let ok = false;
            try {
                await this.startRolloutIfNeeded(op.kind === 'plan-task' ? op.text : 'Execute plan');
                signal.throwIfAborted();
                await this.prepareTools();
                signal.throwIfAborted();
                if (op.kind === 'plan-task') {
                    this.push({ type: 'message', role: 'user', content: `/plan ${op.text}` });
                    await this.agentManager().planTask(op.text, signal);
                    ok = true;
                }
                else
                    ok = (await this.agentManager().executePlan(signal)).ok;
            }
            catch (error) {
                this.emit({ kind: 'error', message: (error as Error).message });
            }
            finally {
                this.busy = false;
                this.emit({ kind: 'turn-ended', ok: ok && !signal.aborted });
            }
        })());
    }
    isBusy(): boolean {
        return this.busy || Boolean(this.agentManagerRef?.list().some(agent => agent.status === 'working'));
    }
    private drainSteerQueue(): string[] {
        const drained = [...this.steerQueue];
        this.steerQueue.length = 0;
        return drained;
    }
    // ─── Turn (sampling + tools loop) ─────────────────────────────────────────
    private async runUserTurn(text: string): Promise<void> {
        this.busy = true;
        const turnId = randomUUID();
        this.abort = new AbortController();
        const startedAt = Date.now();
        this.emit({ kind: 'turn-started', id: turnId });
        try {
            await this.startRolloutIfNeeded(text);
            this.abort.signal.throwIfAborted();
            this.push({ type: 'message', role: 'user', content: text });
            const localReply = smallTalkReply(text);
            if (localReply) {
                const reply = localReply;
                this.push({ type: 'assistant-message', content: reply, toolRuns: [] });
                this.emit({ kind: 'message-completed', role: 'assistant', text: reply, toolRuns: [] });
                this.busy = false;
                this.emit({ kind: 'turn-ended', ok: true });
                return;
            }
            if(!this.agentManagerRef?.list().some(agent=>agent.status==='working'))this.registry.resetDiscovery();
            const clone = cloneRequest(text);
            if (clone) {
                const outcome = await this.registry.execute('git_clone', clone, this.toolCtx());
                this.push({ type: 'tool-output', tool: 'git_clone', output: outcome.output, exitCode: outcome.ok ? 0 : 1 });
                this.push({ type: 'assistant-message', content: outcome.output, toolRuns: [{ tool: 'git_clone', outcome: outcome.ok ? 'ok' : outcome.denied ? 'denied' : 'error' }] });
                this.emit({ kind: 'message-completed', role: 'assistant', text: outcome.output, toolRuns: [{ tool: 'git_clone', outcome: outcome.ok ? 'ok' : 'error' }] });
                this.busy = false;
                this.emit({ kind: 'turn-ended', ok: outcome.ok });
                return;
            }
            const lightweight = explanationOnly(text);
            if (!lightweight)
                await this.prepareTools();
            this.abort.signal.throwIfAborted();
            const system = lightweight ? 'You are MAD. Answer the question concisely.' : await this.buildSystemPrompt();
            const required = executionIntent(text);
            let actionExecuted = false;
            let lastToolFailed = false;
            let corrected = false;
            let followUp = true;
            let continuations = 0;
            let taskTokens = 0;
            while (followUp && continuations < this.config.maxStepsPerTask && !this.abort.signal.aborted) {
                const steered = this.drainSteerQueue();
                for (const extra of steered) {
                    this.push({ type: 'message', role: 'user', content: extra });
                }
                if (this.config.autoCompaction && JSON.stringify(taskHistory(this.context.items)).length > this.config.contextCharBudget) {
                    const beforeCompaction = this.ledger.totals().total;
                    await this.compactNow();
                    taskTokens += this.ledger.totals().total - beforeCompaction;
                }
                let result = await this.sample(system, lightweight, this.config.agentTaskTokenBudget - taskTokens);
                if (result.usage) taskTokens += result.usage.input + result.usage.output;
                continuations++;
                if (!result.toolCalls.length) {
                    const reply = parseAgentReply(result.text);
                    if (reply.kind === 'action' && reply.action)
                        result = { ...result, toolCalls: [{ id: randomUUID(), name: reply.action.tool, args: JSON.stringify(reply.action.args) }] };
                    else if (reply.kind === 'done')
                        result = { ...result, text: reply.summary ?? '' };
                }
                this.recordUsage(result.usage, 'turn');
                if (result.toolCalls.length > 0) {
                    const batch = await this.executeToolCalls(result, continuations, required);
                    actionExecuted ||= batch.executed;
                    lastToolFailed = !batch.ok;
                    followUp = true;
                    continue;
                }
                if (required && !actionExecuted && !corrected && !lastToolFailed) {
                    corrected = true;
                    this.push({ type: 'assistant-message', content: result.text, toolRuns: [] });
                    this.push({ type: 'message', role: 'user', content: 'Perform the requested action with a tool now. Do not give instructions for me to run. If blocked, state the concrete blocker. No action has been executed yet.' });
                    continue;
                }
                if (required && !actionExecuted)
                    result = { ...result, text: result.text + '\n\nNo requested action was executed.' };
                if (result.text.trim()) {
                    this.emit({ kind: 'message-completed', text: result.text, role: 'assistant', toolRuns: [] });
                    this.push({ type: 'assistant-message', content: result.text, toolRuns: [] });
                }
                followUp = this.steerQueue.length > 0;
            }
            this.busy = false;
            this.emit({ kind: 'turn-ended', ok: !this.abort.signal.aborted && !followUp && (!required || actionExecuted) && !lastToolFailed });
            this.emitTokenUsage();
            void startedAt;
            void turnId;
        }
        finally {
            this.busy = false;
        }
    }
    private async sample(system: string, lightweight = false, remainingTokens = this.config.agentTaskTokenBudget): Promise<LlmResult> {
        const client = await this.client();
        if (client.toolProtocol === 'text' && !lightweight)
            system += '\nFor actions output only {"action":{"tool":"name","args":{}}}. When finished output {"done":true,"summary":"your answer"}. MAD executes action objects. Never return command tutorials instead of action objects.';
        const tools = lightweight ? [] : this.registry.listDirect();
        const history = renderMessages('', taskHistory(this.context.items));
        const messages = lightweight ? history.filter(m => m.role !== 'tool' && !m.toolCalls?.length).slice(-4).map(m => ({ ...m, content: m.content.slice(-600) })) : history;
        const request: LlmRequest = {
            workspace: this.workspace,
            system,
            messages: budgetMessages(messages, (lightweight ? 2500 : this.config.contextCharBudget) - JSON.stringify({ system, tools }).length - 100),
            tools,
            maxTokens: lightweight ? 512 : 2200,
            signal: this.abort.signal,
        };
        if (!reserveTaskTokens(request, remainingTokens))
            throw new Error(`Task token budget exhausted. Task incomplete; increase agentTaskTokenBudget (currently ${this.config.agentTaskTokenBudget}) to continue.`);
        const result=await sampleStep({client,request,emit:event=>this.emit(event)});
        return result;
    }
    private async executeToolCalls(result: LlmResult, round: number, required: 'read' | 'write' | null): Promise<{
        ok: boolean;
        executed: boolean;
    }> {
        const toolRuns = [];
        let executed = false;
        let ok = true;
        this.push({ type: 'assistant-message', content: result.text, toolCalls: result.toolCalls, toolRuns: result.toolCalls.map(call => ({ tool: call.name, args: call.args, outcome: 'ok' })) });
        for (const call of result.toolCalls) {
            if (this.abort.signal.aborted)
                break;
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(call.args) as Record<string, unknown>;
            }
            catch {
                ok = false;
                this.push({ type: 'tool-output', callId: call.id, tool: call.name, output: `malformed args JSON: ${call.args.slice(0, 200)}`, exitCode: 1 });
                continue;
            }
            const outcome = await this.registry.execute(call.name, args, this.toolCtx());
            ok &&= outcome.ok;
            if (outcome.ok && (required !== 'write' || this.registry.get(call.name)?.spec.mutates))
                executed = true;
            this.push({
                type: 'tool-output',
                callId: call.id,
                tool: call.name,
                output: outcome.output.slice(0, this.config.toolOutputCharCap) || (outcome.ok ? 'ok' : 'failed'),
                exitCode: outcome.ok ? 0 : 1,
            });
            toolRuns.push({ tool: call.name, outcome: outcome.ok ? 'ok' : outcome.denied ? 'denied' : 'error' });
        }
        this.emit({
            kind: 'note',
            text: `${toolRuns.length} tool call(s) executed`,
        });
        return { ok, executed };
    }
    private toolCtx() {
        return {
            workspace: this.workspace,
            fullAccess: this.config.fullAccess,
            signal: this.abort.signal,
            emit: (event: Event) => this.emit(event),
            requestApproval: (request: ApprovalRequestBrief) => this.requestApproval(request),
        };
    }
    // ─── Approvals (central gate) ─────────────────────────────────────────────
    async requestApproval(request: ApprovalRequestBrief, signal: AbortSignal = this.abort.signal): Promise<ReviewDecision> {
        if (this.closed || signal.aborted)
            return 'denied';
        const classified = classifyRiskSafe(request);
        if (computeRequirement(classified, this.config.approvalPolicy, this.localApprovalStore).requirement === 'skip')
            return 'approved-once';
        const id = randomUUID();
        const decision = await new Promise<ReviewDecision>(resolve => {
            const settle = (decision: ReviewDecision) => {
                signal.removeEventListener('abort', abort);
                this.approvals.delete(id);
                resolve(decision);
                this.emit({ kind: 'approval-resolved', id, decision });
            };
            const abort = () => settle('denied');
            this.approvals.set(id, { resolve: settle });
            signal.addEventListener('abort', abort, { once: true });
            this.emit({ kind: 'approval-requested', id, tool: classified.tool, brief: classified.brief, risk: classified.risk });
        });
        if (decision === 'approved-always') {
            const { ruleKey } = await import('../tools/approvals.js');
            this.localApprovalStore.grant(ruleKey(classified), 'global');
        }
        return decision;
    }
    // ─── Token accounting ─────────────────────────────────────────────────────
    private recordUsage(usage: LlmResult['usage'], kind: 'turn' | 'tool' | 'compaction'): void {
        if (usage) {
            this.ledger.addRecord(kind, usage.input, usage.output, usage.estimated ?? false);
        }
        else {
            // provider without usage metadata: estimate from current context size
            this.ledger.addRecord(kind, this.context.tokenEstimate(), 0, true);
        }
        const totals = this.ledger.totals();
        this.rollouts.record({ item: 'token-usage', usage: { turn: 0, input: totals.input, output: totals.output, at: Date.now() } });
        this.emit({ kind: 'token-usage', input: totals.input, output: totals.output, estimated: totals.estimated });
    }
    private emitTokenUsage(): void {
        const totals = this.ledger.totals();
        this.emit({ kind: 'token-usage', input: totals.input, output: totals.output, estimated: totals.estimated });
    }
    private async compactNow(): Promise<void> {
        try {
            const snapshot = [...this.context.items];
            const client = await this.client();
            const summaryRequest: LlmRequest = {
                system: 'Summarize the conversation for a coding assistant so it can continue. Keep decisions, files, and next steps. Be terse.',
                messages: [{ role: 'user', content: this.context.text().slice(0, 100000) }],
                maxTokens: 900,
                signal: this.abort.signal,
            };
            const summary = await client.complete(summaryRequest);
            this.abort.signal.throwIfAborted();
            if (snapshot.length !== this.context.items.length || snapshot.some((item, index) => item !== this.context.items[index]))
                throw new Error('History changed during compaction; retry when agents are idle');
            if (!summary.text.trim())
                throw new Error('Provider returned an empty summary');
            const compactedItems = this.context.compact(summary.text.slice(0, Math.floor(this.config.contextCharBudget / 3)), 8, Math.floor(this.config.contextCharBudget / 2));
            this.rollouts.record({ item: 'history-snapshot', items: this.context.items });
            this.recordUsage(summary.usage, 'compaction');
            this.emit({ kind: 'compacted', summary: (compactedItems[0] as {
                    summary: string;
                }).summary });
        }
        catch (error) {
            this.emit({ kind: 'error', message: `compaction failed: ${(error as Error).message}`, recoverable: true });
        }
    }
    // ─── Prompt/provider helpers ──────────────────────────────────────────────
    private async prepareTools(): Promise<void> {
        if (this.mcpReady)
            return;
        if (!this.toolsStart)
            this.toolsStart = (async () => {
                await this.mcp.start(this.config, text => this.note(text));
                if (this.closed) {
                    this.mcp.stop();
                    return;
                }
                await this.mcp.bridgeInto(this.registry);
                this.mcpReady = true;
            })().catch(error => { this.toolsStart = null; throw error; });
        await this.toolsStart;
    }
    private async buildSystemPrompt(): Promise<string> {
        // Stable, compact prefix. Repository trees and AST context are fetched on demand.
        const guidance = [workspaceGuidance(this.workspace)];
        if (this.repoContext)
            guidance.push(this.repoContext.text);
        return compileSystemPrompt({ chat: true, contextText: guidance.join('\n\n'), tools: this.registry.listDirect() });
    }
    setRepoContextOverride(context: RepoContext): void {
        this.repoContext = context;
    }
    private async clientFor(model?: string): Promise<ProviderClient> {
        if (!model)
            return this.client();
        const key = `${this.providerName}:${model}`;
        if (!this.modelClients.has(key))
            this.modelClients.set(key, buildProviderClient(this.providerName, { model, config: this.config }));
        const client=this.modelClients.get(key)!;await client.initialize?.();return client;
    }
    async client(): Promise<ProviderClient> {
        if (this.providerClient)
            return this.providerClient;
        const chain: string[] = fallbackChain(this.config);
        const order = [this.providerName, ...chain];
        const errors: string[] = [];
        for (const name of order) {
            try {
                if (!this.config.enabledProviders.includes(name))
                    continue;
                const client = buildProviderClient(name, { config: this.config, model: name === this.providerName ? this.config.defaultModel || undefined : undefined });
                if (client.hasKey() || name === 'ollama') {
                    await client.initialize?.();
                    this.providerClient = client;
                    if (name !== this.providerName) {
                        const previousName = this.providerName;
                        this.providerName = name;
                        this.config.defaultProvider = name;
                        this.config.defaultModel = '';
                        this.emit({ kind: 'note', text: `provider ${previousName} unavailable — fell back to ${name}` });
                    }
                    return client;
                }
            }
            catch (error) {
                if(name==='ollama'&&name===this.providerName)throw error;
                errors.push(`${name}: ${(error as Error).message}`);
            }
        }
        throw new Error(`no usable provider. Tried: ${order.join(', ')}. ${errors.slice(0, 2).join(' ')}`);
    }
    async selectProvider(name:string,model?:string):Promise<void> {
        if(this.isBusy())throw new Error('Stop active work before changing provider');
        const config=structuredClone(this.config);
        if(!config.enabledProviders.includes(name))config.enabledProviders.push(name);
        const selectedModel = model ?? this.selectedModels.get(name);
        const client=buildProviderClient(name,{config,model:selectedModel});
        try {
            await client.initialize?.();
            if(!client.hasKey())throw new Error(`Provider ${name} is unavailable; connect it first`);
            if(this.isBusy())throw new Error('A task started while connecting; retry when it finishes');
        }catch(error){await client.close?.();throw error;}
        const previous=this.providerClient;
        this.config.enabledProviders=config.enabledProviders;
        this.config.defaultProvider=name;this.config.defaultModel=selectedModel??'';
        if (selectedModel) this.selectedModels.set(name, selectedModel);
        this.providerName=name;this.providerClient=client;
        await previous?.close?.();
        this.note(`Connected: ${name} · ${client.defaultModel()}`);
    }
    forceProvider(name: string, model: string | undefined): void {
        if (this.isBusy() || this.agentManagerRef?.list().some(agent => agent.status === 'working'))
            throw new Error('Stop active work before changing provider');
        if(name==='ollama'&&!this.config.enabledProviders.includes(name))this.config.enabledProviders.push(name);
        if (!this.config.enabledProviders.includes(name))
            throw new Error(`Provider ${name} is disabled; enable it with mad config ${name} --enable`);
        void this.providerClient?.close?.();
        this.providerClient = null;
        this.providerName = name;
        this.config.defaultModel = model ?? '';
        this.config.defaultProvider = name;
    }
    sessionModel(): string {
        const clientHasModel = this.providerClient?.defaultModel?.() ?? this.config.defaultModel;
        return clientHasModel && clientHasModel.length ? clientHasModel : this.config.defaultModel || getModelFor(this.providerName as ProviderName);
    }
    setAccessMode(mode: 'ask' | 'full'): void {
        if (this.isBusy())
            throw new Error('Stop active work before changing permissions');
        this.config.approvalPolicy = mode === 'full' ? 'never' : 'always';
        this.config.fullAccess = mode === 'full';
        this.note(mode === 'full' ? 'Full access enabled for this session: tool actions run without approval, including paths outside the workspace.' : 'Ask permission enabled: writes, shell commands and MCP actions require approval.');
    }
    accessMode(): 'ask' | 'full' { return this.config.fullAccess && this.config.approvalPolicy === 'never' ? 'full' : 'ask'; }
    permissionRules() { return this.localApprovalStore.keys(); }
    clearPermissions(): void { this.localApprovalStore.clear(); }
    providerLabel(): string {
        return this.providerName;
    }
    private push(item: ResponseItem): void {
        this.context.push(item);
        this.rollouts.record({ item: 'response', response: this.context.last! });
    }
    resume(file: string): void {
        if (this.isBusy())
            throw new Error('Interrupt active work before resuming.');
        const replay = replayResponseItems(file);
        if (!replay.meta)
            throw new Error('Session has no readable metadata.');
        if (replay.meta.workspace !== this.workspace)
            throw new Error(`Session belongs to ${replay.meta.workspace}`);
        this.context.replay(replay.items);
        this.rollouts.record({ item: 'history-snapshot', items: this.context.items });
        this.note(`Resumed ${replay.meta.id}`);
    }
    private track(job: Promise<unknown>): void {
        this.jobs.add(job);
        void job.finally(() => this.jobs.delete(job)).catch(() => { });
    }
    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        this.cancel();
        this.mcp.stop();
        await Promise.allSettled([...this.jobs]);
        await this.agentManagerRef?.waitForIdle();
        await this.rolloutStart?.catch(() => { });
        await this.providerClient?.close?.();
        await Promise.all([...this.modelClients.values()].map(client => client.close?.()));
        await this.rollouts.close();
    }
    async startRollout(instruction: string | undefined): Promise<void> {
        if (this.rollouts?.filename)
            return;
        const recorder = this.rollouts;
        await recorder.start({
            id: this.id,
            startedAt: Date.now(),
            workspace: this.workspace,
            instruction,
            provider: this.providerLabel(),
            model: this.sessionModel(),
        });
    }
    async startRolloutIfNeeded(instruction: string): Promise<void> {
        if (this.rolloutStart) {
            await this.rolloutStart;
            return;
        }
        if (this.rollouts.filename)
            return;
        if (!this.rolloutStart)
            this.rolloutStart = this.startRollout(instruction).catch(error => { this.rolloutStart = null; throw error; });
        await this.rolloutStart;
    }
}
