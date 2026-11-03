// ─── Agent manager: named agents you create with /agent, plus the pipeline ──
// Agents are first-class named sessions. The DAG is compiled from the agent's
// plan and then the DAG engine owns execution + verification.
import type { AgentRole, Event } from '../protocol/types.js';
import type { DagNode, DagToolBridge, DagNodeExecutor } from '../dag/types.js';
import { DagEngine } from '../dag/engine.js';
import { dagTools } from '../dag/tools.js';
import type { Tool, ApprovalRequestBrief } from '../tools/types.js';
import { BUILTIN_TOOLS } from '../tools/builtin.js';
import type { ProviderClient } from '../providers/types.js';
import { runWorker, type WorkerOutcome } from '../agent/worker.js';
import { buildPlan, type Plan, type PlanTask } from '../agent/planner.js';
import { workspaceGuidance } from '../agent/guidance.js';
import { collectRepoContext } from '../agent/context.js';
import { verifyPrompt } from '../agent/prompts.js';
import type { MadConfig } from '../config/loader.js';
export interface AgentEntry {
    name: string;
    role: AgentRole;
    model?: string;
    status: 'idle' | 'working' | 'blocked' | 'done' | 'stopped';
    detail?: string;
    taskQueue: string[];
}
const ROLE_TOOL_FILTER: Record<AgentRole, ((tool: Tool) => boolean) | null> = {
    planner: null,
    architect: (tool) => tool.spec.readOnly,
    coder: (tool) => tool.spec.name === 'run_shell' || tool.spec.mutates || tool.spec.readOnly,
    verifier: (tool) => tool.spec.readOnly || tool.spec.name === 'run_shell',
    debugger: (tool) => tool.spec.name === 'run_shell' || tool.spec.mutates || tool.spec.readOnly,
    custom: null,
};
function toolsForRole(role: AgentRole): Tool[] {
    const filter = ROLE_TOOL_FILTER[role];
    return filter ? BUILTIN_TOOLS.filter(filter) : BUILTIN_TOOLS;
}
export interface AgentManagerOptions {
    workspace: string;
    config: MadConfig;
    tools?: () => Tool[];
    history?: () => string;
    emit: (event: Event) => void;
    client: (model?: string) => Promise<ProviderClient>;
    requestApproval: (request: ApprovalRequestBrief, signal?: AbortSignal) => Promise<'approved-once' | 'approved-always' | 'denied'>;
    signal: AbortSignal;
}
export class AgentManager {
    private readonly agents = new Map<string, AgentEntry>();
    private readonly activeJobs = new Set<Promise<unknown>>();
    private readonly controllers = new Map<string, AbortController>();
    private pendingPlan: {
        goal: string;
        plan: Plan;
    } | null = null;
    private workflowSequence = 0;
    private pipelineController: AbortController | null = null;
    private activeEngine: DagEngine | null = null;
    private readonly bridgeRef: {
        bridge: DagToolBridge | null;
    } = { bridge: null };
    constructor(private readonly options: AgentManagerOptions) { }
    private toolsForRole(role: AgentRole): Tool[] {
        const filter = ROLE_TOOL_FILTER[role];
        const tools = this.options.tools?.() ?? BUILTIN_TOOLS;
        return filter ? tools.filter(filter) : tools;
    }
    list(): AgentEntry[] {
        return Array.from(this.agents.values()).map((entry) => ({ ...entry, taskQueue: [...entry.taskQueue] }));
    }
    getBridge(): DagToolBridge | null {
        return this.activeEngine?.toolBridge() ?? this.bridgeRef.bridge;
    }
    activeNodes(): DagNode[] {
        return this.activeEngine?.allNodes ?? [];
    }
    activeGoal(): string {
        return this.activeEngine?.goal ?? '';
    }
    async createAgent(options: {
        name: string;
        role: AgentRole;
        model?: string;
        task?: string;
    }): Promise<AgentEntry> {
        const name = options.name || `agent-${this.agents.size + 1}`;
        if (this.agents.has(name))
            throw new Error(`agent '${name}' already exists`);
        const entry: AgentEntry = { name, role: options.role, model: options.model, status: 'idle', taskQueue: [] };
        this.agents.set(name, entry);
        this.options.emit({ kind: 'agent-spawned', name, role: options.role });
        if (options.task) {
            await this.submitTask(name, options.task);
        }
        return entry;
    }
    submitTask(name: string, task: string): Promise<WorkerOutcome | null> {
        const job = this.runTask(name, task);
        this.activeJobs.add(job);
        void job.finally(() => this.activeJobs.delete(job)).catch(() => { });
        return job;
    }
    async waitForIdle(): Promise<void> { await Promise.allSettled([...this.activeJobs]); }
    private async runTask(name: string, task: string): Promise<WorkerOutcome | null> {
        const entry = this.agents.get(name);
        if (!entry) {
            throw new Error(`no agent named '${name}' — create with /agent ${name}`);
        }
        if (this.controllers.has(name))
            throw new Error(`Agent '${name}' is already working`);
        const controller = new AbortController();
        this.controllers.set(name, controller);
        entry.status = 'working';
        entry.taskQueue = [task];
        this.options.emit({ kind: 'agent-status', name, status: 'working', detail: task });
        try {
            const client = await this.options.client(entry.model);
            const context = { text: workspaceGuidance(this.options.workspace) };
            const outcome = await runWorker({
                role: entry.role,
                agentName: name,
                task,
                workspace: this.options.workspace,
                contextText: context.text,
                client,
                tools: this.toolsForRole(entry.role),
                signal: controller.signal,
                emit: this.options.emit,
                requestApproval: request => this.options.requestApproval(request, controller.signal),
                maxSteps: this.options.config.maxStepsPerTask,
                tokenBudget: this.options.config.agentTaskTokenBudget,
                contextCharBudget: this.options.config.contextCharBudget,
                toolOutputCharCap: this.options.config.toolOutputCharCap,
                fullAccess: this.options.config.fullAccess,
            });
            entry.status = controller.signal.aborted ? 'stopped' : outcome.ok ? 'done' : 'blocked';
            entry.detail = outcome.summary;
            this.options.emit({ kind: 'message-completed', text: outcome.summary, role: 'agent', agent: name, toolRuns: [] });
            this.options.emit({ kind: 'agent-status', name, status: entry.status, detail: entry.detail });
            return outcome;
        }
        catch (error) {
            entry.status = controller.signal.aborted ? 'stopped' : 'blocked';
            entry.detail = (error as Error).message.slice(0, 160);
            this.options.emit({ kind: 'agent-status', name, status: entry.status, detail: entry.detail });
            return null;
        }
        finally {
            this.controllers.delete(name);
            entry.taskQueue = [];
        }
    }
    stopAgent(name: string): boolean {
        const entry = this.agents.get(name);
        if (!entry)
            return false;
        this.controllers.get(name)?.abort(new Error('Agent stopped'));
        entry.status = 'stopped';
        this.options.emit({ kind: 'agent-status', name, status: 'stopped' });
        return true;
    }
    cancelAll(): void {
        for (const controller of this.controllers.values())
            controller.abort();
        this.pipelineController?.abort();
    }
    // ─── Pipeline: plan -> DAG -> monitored execution ──────────────────────────
    async planTask(goal: string, signal: AbortSignal): Promise<void> {
        if (this.pipelineController)
            throw new Error('A workflow is already running');
        const client = await this.options.client();
        const context = await collectRepoContext(this.options.workspace, goal);
        const plan = await buildPlan(goal, [this.options.history?.(), context.text].filter(Boolean).join('\n\n'), context.testCommand, client, signal, usage => this.options.emit({ kind: 'token-usage', ...usage }));
        signal.throwIfAborted();
        this.pendingPlan = { goal, plan };
        if (plan.tasks.length) {
            this.activeEngine = this.compileDag(plan.tasks);
            this.options.emit({ kind: 'message-completed', role: 'assistant', toolRuns: [], text: plan.tasks.map(task => `${task.id}. ${task.title} (${task.role})${task.dependsOn.length ? ` — after ${task.dependsOn.join(', ')}` : ''}`).join('\n') + '\nPlan ready. Use /run to execute it.' });
        }
        else
            this.options.emit({ kind: 'message-completed', role: 'assistant', toolRuns: [], text: plan.answer ?? 'No work to plan.' });
    }
    async executePlan(signal: AbortSignal): Promise<{
        ok: boolean;
        summary: string;
    }> {
        if (!this.pendingPlan)
            throw new Error('No plan ready. Use /plan <task> first.');
        const pending = this.pendingPlan;
        this.pendingPlan = null;
        return this.runPreparedPlan(pending.goal, pending.plan, signal);
    }
    private async runPreparedPlan(goal: string, preparedPlan: Plan, signal: AbortSignal): Promise<{
        ok: boolean;
        summary: string;
    }> {
        if (this.pipelineController)
            throw new Error('A workflow is already running');
        const controller = new AbortController();
        this.pipelineController = controller;
        const relayAbort = () => controller.abort(signal.reason);
        if (signal.aborted)
            relayAbort();
        else
            signal.addEventListener('abort', relayAbort, { once: true });
        try {
            controller.signal.throwIfAborted();
            const client = await this.options.client();
            const context = await collectRepoContext(this.options.workspace, goal);
            const plan = preparedPlan;
            if (plan.answer && plan.tasks.length === 0) {
                this.options.emit({ kind: 'message-completed', text: plan.answer, role: 'assistant', agent: 'planner', toolRuns: [] });
                return { ok: true, summary: plan.answer };
            }
            const workflow = ++this.workflowSequence;
            for (const task of plan.tasks) {
                task.agent = task.agent ?? `workflow-${workflow}-${task.id}`;
                if (!this.agents.has(task.agent))
                    await this.createAgent({ name: task.agent, role: task.role });
            }
            const engine = this.compileDag(plan.tasks);
            this.activeEngine = engine;
            const registered = this.registerAgentNames(plan.tasks);
            let fixRounds = 0;
            const maxRounds = this.options.config.verifyRounds;
            let ok = false;
            let summary = '';
            for (let round = 0; round <= maxRounds; round++) {
                engine.executor = this.makeExecutor(registered, engine);
                const outcomeResult = await engine.run({
                    signal: controller.signal,
                    maxParallel: readTasksParallel(engine),
                    maxAttemptsPerNode: 2,
                });
                ok = outcomeResult.ok;
                summary = outcomeResult.summary;
                const failedNode = engine.allNodes.find((node) => node.status === 'failed');
                if (ok && !failedNode)
                    break;
                if (!failedNode || fixRounds >= maxRounds)
                    break;
                // Repair runs after the failed attempt, then the original node is reverified.
                const repair = await runWorker({ role: 'debugger', agentName: `repair_${fixRounds + 1}`, task: `Repair failure in ${failedNode.title}: ${failedNode.result}`, workspace: this.options.workspace, contextText: context.text, client, tools: this.toolsForRole('debugger'), signal: controller.signal, emit: this.options.emit, requestApproval: request => this.options.requestApproval(request, controller.signal), maxSteps: this.options.config.maxStepsPerTask, tokenBudget: this.options.config.agentTaskTokenBudget });
                if (!repair.ok)
                    break;
                const bridge = engine.toolBridge();
                bridge.setNodeStatus(failedNode.id, 'pending');
                for (const node of engine.allNodes)
                    if (node.status === 'skipped' || node.status === 'blocked')
                        bridge.setNodeStatus(node.id, 'pending');
                fixRounds += 1;
            }
            this.options.emit({ kind: 'message-completed', text: summary, role: 'assistant', toolRuns: [] });
            this.options.emit({ kind: 'dag-finished', ok, summary });
            return { ok, summary };
        }
        finally {
            signal.removeEventListener('abort', relayAbort);
            this.pipelineController = null;
        }
    }
    private registerAgentNames(tasks: PlanTask[]): Map<string, string> {
        // tasks marked with agent:<name> get matched to existing named agents
        const mapping = new Map<string, string>();
        for (const task of tasks) {
            if (task.agent && this.agents.has(task.agent))
                mapping.set(task.id, task.agent);
        }
        return mapping;
    }
    private compileDag(tasks: PlanTask[]): DagEngine {
        const engine = new DagEngine(tasks.map((task) => ({
            id: task.id,
            title: task.detail ? `${task.title} — ${task.detail.slice(0, 160)}` : task.title,
            detail: task.detail,
            role: task.role,
            status: 'pending',
            dependsOn: task.dependsOn,
            attempts: 0,
            agent: task.agent,
        })), tasks.map((task) => task.title).join(' | ').slice(0, 120));
        engine.on('event', event => {
            if (event.node)
                this.options.emit({ kind: 'dag-node', node: event.node });
        });
        this.bridgeRef.bridge = engine.toolBridge();
        this.options.emit({
            kind: 'dag-created',
            goal: engine.goal,
            nodes: engine.allNodes.map((node) => ({
                id: node.id,
                title: node.title,
                detail: node.detail,
                status: node.status,
                dependsOn: node.dependsOn,
                attempts: node.attempts,
                agent: node.agent,
                byAgent: node.byAgent,
            })),
        });
        return engine;
    }
    private makeExecutor(agentNames: Map<string, string>, engine: DagEngine) {
        return async (node: DagNode, { signal }: {
            signal: AbortSignal;
        }) => {
            const assignedAgent = agentNames.get(node.id) ?? node.agent ?? node.id;
            const entry = this.agents.get(assignedAgent);
            if (!entry)
                throw new Error(`Missing workflow agent: ${assignedAgent}`);
            if (this.controllers.has(assignedAgent))
                throw new Error(`Agent '${assignedAgent}' is already working`);
            if (entry.status === 'stopped')
                return { ok: false, result: 'Agent stopped by user' };
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            if (signal.aborted)
                abort();
            else
                signal.addEventListener('abort', abort, { once: true });
            this.controllers.set(assignedAgent, controller);
            entry.status = 'working';
            this.options.emit({ kind: 'agent-status', name: assignedAgent, status: 'working', detail: node.title });
            try {
                controller.signal.throwIfAborted();
                const client = await this.options.client(entry.model);
                const deps = node.dependsOn.map(id => engine.node(id)).filter(Boolean).map(dep => `${dep!.id}: ${dep!.result ?? ''}`).join('\n');
                for (const id of node.dependsOn) {
                    const dependency = engine.node(id);
                    if (dependency) this.options.emit({ kind: 'agent-communication', from: agentNames.get(id) ?? dependency.agent ?? id, to: assignedAgent, text: `${dependency.title}: ${dependency.result ?? ''}` });
                }
                const task = [`Task: ${node.title}`, node.detail, deps ? `Completed dependencies:\n${deps}` : ''].filter(Boolean).join('\n');
                const context = { text: workspaceGuidance(this.options.workspace) };
                const bridge = engine.toolBridge();
                const scopedBridge: DagToolBridge = { ...bridge, setNodeStatus: (id, status, result) => id === node.id && bridge.setNodeStatus(id, status, result, assignedAgent) };
                const outcome = await runWorker({ role: node.role ?? entry.role, agentName: assignedAgent, task, workspace: this.options.workspace, contextText: context.text, client, tools: [...this.toolsForRole(node.role ?? entry.role), ...dagTools({ bridge: scopedBridge })], signal: controller.signal, emit: this.options.emit, requestApproval: request => this.options.requestApproval(request, controller.signal), maxSteps: this.options.config.maxStepsPerTask, tokenBudget: this.options.config.agentTaskTokenBudget, contextCharBudget: this.options.config.contextCharBudget, toolOutputCharCap: this.options.config.toolOutputCharCap, fullAccess: this.options.config.fullAccess });
                entry.status = controller.signal.aborted ? 'stopped' : outcome.ok ? 'done' : 'blocked';
                entry.detail = outcome.summary;
                this.options.emit({ kind: 'message-completed', text: outcome.summary, role: 'agent', agent: assignedAgent, toolRuns: outcome.toolRuns.map(run => ({ tool: run.tool, outcome: run.outcome as 'ok' | 'error' | 'denied' })) });
                return { ok: outcome.ok && !controller.signal.aborted, result: outcome.summary };
            }
            catch (error) {
                entry.status = controller.signal.aborted ? 'stopped' : 'blocked';
                entry.detail = (error as Error).message;
                throw error;
            }
            finally {
                signal.removeEventListener('abort', abort);
                this.controllers.delete(assignedAgent);
                this.options.emit({ kind: 'agent-status', name: assignedAgent, status: entry.status, detail: entry.detail });
            }
        };
    }
    // verifier verdict comes from the worker's structured JSON; no prose regex
    async verifyWith(doubleCheck: string): Promise<{
        pass: boolean;
        issues: string[];
    }> {
        const client = await this.options.client();
        const outcome = await runWorker({
            role: 'verifier',
            agentName: 'verifier',
            task: doubleCheck,
            workspace: this.options.workspace,
            contextText: verifyPrompt(),
            client,
            tools: this.toolsForRole('verifier'),
            signal: this.options.signal,
            emit: this.options.emit,
            requestApproval: this.options.requestApproval,
            maxSteps: 6,
            tokenBudget: this.options.config.agentTaskTokenBudget,
        });
        let pass = false;
        let issues: string[] = [];
        try {
            const verdict = JSON.parse(outcome.summary);
            pass = outcome.ok && verdict.pass === true;
            issues = Array.isArray(verdict.issues) ? verdict.issues.map(String) : [];
        }
        catch {
            issues = ['Verifier returned no structured verdict'];
        }
        return { pass, issues };
    }
}
function roleFromNode(node: DagNode): AgentRole {
    if (node.role)
        return node.role;
    if (node.agent?.startsWith(node.id))
        return 'coder';
    const title = `${node.title} ${node.detail ?? ''}`.toLowerCase();
    if (title.includes('verif') || title.includes('test'))
        return 'verifier';
    if (title.includes('debug') || title.includes('repair') || title.includes('fix'))
        return 'debugger';
    if (title.includes('design') || title.includes('plan') || title.includes('architect'))
        return 'planner';
    return 'coder';
}
/** read-only analysis nodes can run 3-wide; write nodes stay sequential. */
function readTasksParallel(engine: DagEngine): number {
    const nodes = engine.allNodes;
    const writeNodes = nodes.filter((node) => roleFromNode(node) === 'coder' || roleFromNode(node) === 'debugger');
    return writeNodes.length ? 1 : 3;
}
