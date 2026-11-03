import type { AgentRole } from '../protocol/types.js';
import type { ProviderClient, LlmUsage } from '../providers/types.js';
import { planPrompt } from './prompts.js';
import { parseAgentReply } from './protocol.js';
export interface PlanTask {
    id: string;
    title: string;
    detail?: string;
    role: AgentRole;
    dependsOn: string[];
    agent?: string;
}
export interface Plan {
    answer: string | null;
    tasks: PlanTask[];
}
const ROLES = new Set(['architect', 'planner', 'coder', 'debugger', 'verifier', 'custom']);
export async function buildPlan(goal: string, contextText: string, testCommand: string | null, client: ProviderClient, signal: AbortSignal, onUsage?: (usage: LlmUsage) => void): Promise<Plan> {
    const messages: import('../providers/types.js').ProviderMessage[] = [{ role: 'user', content: planPrompt(goal, contextText, testCommand ?? '') }];
    for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        const result = await client.complete({ system: 'You are the MAD planner. Respond with a single JSON object only.', messages, maxTokens: 2500, temperature: 0, signal });
        if (result.usage)
            onUsage?.(result.usage);
        signal.throwIfAborted();
        try {
            const reply = parseAgentReply(result.text);
            const text = reply.kind === 'done' && reply.summary ? reply.summary : result.text;
            const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
            return normalizePlan(JSON.parse(json), goal);
        }
        catch (error) {
            if (attempt === 1)
                throw new Error(`Planner returned an invalid plan: ${(error as Error).message}`);
            messages.push({ role: 'assistant', content: result.text }, { role: 'user', content: `Invalid plan: ${(error as Error).message}. Return a valid answer with tasks:[], or a nonempty dependency-ordered plan with unique IDs, roles, and dependencies. Do not execute anything.` });
        }
    }
    throw new Error('Planner failed');
}
/** Validate before creating any workers. Invalid output never authorizes fallback work. */
export function normalizePlan(raw: unknown, _goal: string): Plan {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Expected a plan object');
    const plan = raw as Record<string, unknown>;
    if (!Array.isArray(plan.tasks))
        throw new Error('tasks must be an array');
    const answer = typeof plan.answer === 'string' && plan.answer.trim() ? plan.answer : null;
    if (!plan.tasks.length) {
        if (!answer)
            throw new Error('Empty plan has no answer');
        return { answer, tasks: [] };
    }
    const tasks: PlanTask[] = plan.tasks.map((value: unknown) => {
        if (!value || typeof value !== 'object')
            throw new Error('Invalid task');
        const task = value as Record<string, unknown>;
        if (typeof task.id !== 'string' || !task.id.trim() || typeof task.title !== 'string' || !task.title.trim())
            throw new Error('Task needs id and title');
        if (typeof task.role !== 'string' || !ROLES.has(task.role))
            throw new Error(`Invalid role for ${task.id}`);
        if (!Array.isArray(task.dependsOn) || !task.dependsOn.every(id => typeof id === 'string'))
            throw new Error(`Invalid dependencies for ${task.id}`);
        return { id: task.id, title: task.title, role: task.role as AgentRole, dependsOn: [...new Set(task.dependsOn)], detail: typeof task.detail === 'string' ? task.detail : undefined, agent: typeof task.agent === 'string' ? task.agent : undefined };
    });
    const ids = new Map(tasks.map(task => [task.id, task]));
    if (ids.size !== tasks.length)
        throw new Error('Duplicate task IDs');
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string) => {
        if (visiting.has(id))
            throw new Error(`Dependency cycle at ${id}`);
        if (visited.has(id))
            return;
        const task = ids.get(id);
        if (!task)
            throw new Error(`Missing dependency ${id}`);
        visiting.add(id);
        task.dependsOn.forEach(visit);
        visiting.delete(id);
        visited.add(id);
    };
    tasks.forEach(task => visit(task.id));
    if (!tasks.some(task => task.role === 'verifier')) {
        let id = 'verify';
        while (ids.has(id))
            id += '-final';
        tasks.push({ id, title: 'Verify the implementation and report a structured verdict', role: 'verifier', dependsOn: tasks.map(task => task.id) });
    }
    return { answer: null, tasks };
}
