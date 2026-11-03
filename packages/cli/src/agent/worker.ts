// ─── Worker: one agent's ReAct loop (streaming provider under the hood) ─────
import type { AgentRole, Event, ReviewDecision } from '../protocol/types.js';
import type { LlmRequest, ProviderClient, ProviderMessage } from '../providers/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolContext as Ctx, Tool, ApprovalRequestBrief } from '../tools/types.js';
import {sampleStep} from './step.js';
import { compileSystemPrompt } from './prompts.js';
import { parseAgentReply } from './protocol.js';
import { budgetMessages, reserveTaskTokens } from '../tokens/budget.js';
const CLIP_CHARS = 48000;
const STEP_MAX_TOKENS = 2200;
export interface WorkerOptions {
    role: AgentRole;
    agentName: string;
    task: string;
    workspace: string;
    contextText: string;
    client: ProviderClient;
    tools: Tool[];
    signal: AbortSignal;
    emit: (event: Event) => void;
    requestApproval: (request: ApprovalRequestBrief) => Promise<ReviewDecision>;
    maxSteps?: number;
    tokenBudget?: number;
    fullAccess?: boolean;
    contextCharBudget?: number;
    toolOutputCharCap?: number;
    busSnapshot?: string;
}
export interface WorkerOutcome {
    ok: boolean;
    summary: string;
    steps: number;
    toolRuns: Array<{
        tool: string;
        outcome: string;
    }>;
    changedFiles: string[];
}
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
export async function runWorker(options: WorkerOptions): Promise<WorkerOutcome> {
    const maxSteps = options.maxSteps ?? 14;
    const registry = new ToolRegistry();
    for (const tool of options.tools)
        registry.register(tool);
    const messages: ProviderMessage[] = [];
    let steps = 0;
    const toolRuns: WorkerOutcome['toolRuns'] = [];
    const changedFiles = new Set<string>();
    let summary = '';
    let ok = false;
    const tokenBudget = options.tokenBudget ?? 30000;
    let spentTokens = 0;
    const ctx: Ctx = {
        workspace: options.workspace,
        fullAccess: options.fullAccess,
        signal: options.signal,
        emit: options.emit,
        requestApproval: options.requestApproval,
        agent: options.agentName,
    };
    const system = compileSystemPrompt({
        role: options.role,
        contextText: options.contextText.slice(0, Math.floor((options.contextCharBudget ?? CLIP_CHARS) / 3)),
        tools: registry.listDirect(),
        busSnapshot: options.busSnapshot,
    });
    while (steps < maxSteps && !options.signal.aborted) {
        steps += 1;
        if (steps === 1)
            messages.push({ role: 'user', content: options.task });
        const request: LlmRequest = {
            workspace: options.workspace,
            system,
            messages: budgetMessages(messages, (options.contextCharBudget ?? CLIP_CHARS) - JSON.stringify({ system, tools: registry.listDirect() }).length - 100),
            tools: registry.listDirect(),
            maxTokens: STEP_MAX_TOKENS,
            signal: options.signal,
        };
        // Reserve room for a useful response, with a margin for provider-specific tokenization.
        // Provider-reported usage replaces this estimate after each completed call.
        if (!reserveTaskTokens(request, tokenBudget - spentTokens)) {
            summary = `Agent token budget exhausted (${spentTokens} used or estimated; limit ${tokenBudget}). Task incomplete. Increase agentTaskTokenBudget to continue.`;
            break;
        }
        const result=await sampleStep({client:options.client,request,emit:options.emit,streamId:options.agentName,agent:options.agentName});
        if (result.usage) {
            spentTokens += result.usage.input + result.usage.output;
            options.emit({ kind: 'token-usage', ...result.usage });
        }
        // native tool calls first; JSON protocol as lowest common denominator
        if (result.toolCalls.length > 0) {
            messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
            for (const call of result.toolCalls) {
                if (options.signal.aborted)
                    break;
                const args = safeParse(call.args);
                const outcome = await registry.execute(call.name, args, ctx);
                toolRuns.push({ tool: call.name, outcome: outcome.ok ? 'ok' : outcome.denied ? 'denied' : 'error' });
                if (outcome.ok && WRITE_TOOLS.has(call.name))
                    changedFiles.add(String(args.path ?? ''));
                messages.push({
                    role: 'tool', callId: call.id, name: call.name,
                    content: (outcome.output ?? '').slice(0, options.toolOutputCharCap ?? 4000),
                });
            }
            continue;
        }
        if (options.role === 'verifier') {
            try {
                const verdict = JSON.parse(result.text);
                if (typeof verdict.pass === 'boolean' && Array.isArray(verdict.issues)) {
                    summary = result.text;
                    ok = verdict.pass && !options.signal.aborted;
                    break;
                }
            }
            catch { /* Other roles use the shared action/done envelope. */ }
        }
        const parsed = parseAgentReply(result.text);
        if (parsed.kind === 'action' && parsed.action) {
            const outcome = await registry.execute(parsed.action.tool, parsed.action.args, ctx);
            toolRuns.push({ tool: parsed.action.tool, outcome: outcome.ok ? 'ok' : outcome.denied ? 'denied' : 'error' });
            if (outcome.ok && WRITE_TOOLS.has(parsed.action.tool)) {
                changedFiles.add(String((parsed.action.args as Record<string, unknown>).path ?? ''));
            }
            messages.push({ role: 'assistant', content: result.text });
            messages.push({
                role: 'user',
                content: `[tool ${parsed.action.tool} ${outcome.ok ? 'ok' : 'FAILED'}]\n${(outcome.output ?? '').slice(0, options.toolOutputCharCap ?? 4000)}`,
            });
            continue;
        }
        if (parsed.kind === 'done') {
            summary = parsed.summary ?? '';
            ok = !options.signal.aborted;
            if (options.role === 'verifier') {
                try {
                    const verdict = JSON.parse(summary);
                    ok = ok && verdict.pass === true && Array.isArray(verdict.issues);
                }
                catch {
                    ok = false;
                }
            }
            break;
        }
        messages.push({ role: 'assistant', content: result.text });
        messages.push({ role: 'user', content: 'Invalid reply. Reply with exactly one JSON object: {"action":{"tool":"...","args":{}}} or {"done":true,"summary":"..."}' });
    }
    if (!summary)
        summary = options.signal.aborted ? 'aborted' : `stopped at step limit (${steps})`;
    if (options.signal.aborted)
        ok = false;
    return { ok, summary, steps, toolRuns, changedFiles: Array.from(changedFiles) };
}
function safeParse(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    }
    catch {
        return {};
    }
}
