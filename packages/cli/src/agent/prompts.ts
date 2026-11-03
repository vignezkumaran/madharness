// ─── System prompt compilation (single source of truth) ─────────────────────
import type { AgentRole, ToolSpec } from '../protocol/types.js';
const CHAT_BASE = `You are MAD, a terminal coding assistant running inside the user's workspace.
Rules:
- Be concise and concrete. Reference real files/paths you have read.
- For action requests, execute with tools, not a tutorial or suggested commands. Use git_clone for cloning and run_shell for commands. Never claim an action happened without a successful tool result.
- Execute tasks directly. Do not create a plan or spawn agents unless the user explicitly asks.
- Prefer targeted file line ranges over repeating whole-file reads.
- Read the relevant files before editing. Use repo_context only when extra project context is needed; avoid broad scans for simple tasks.
- Use the provided tools to read code before making claims about it.
- For current events, use an available web search tool; if none is available, say current information cannot be verified rather than guessing.
- Write/edit files only through tools, never ask the user to do it.
- After code changes, run relevant checks. Report failures and incomplete work accurately.
- If context is insufficient, say what is missing.`;
const ROLE_GUIDES: Record<AgentRole, string> = {
    planner: `Plan the task into tasks: {id,title,detail,role,dependsOn}. Tasks should be small (≤15 min), dependency-ordered. Prefer coder for writes, verifier for checks, debugger for failing tests.`,
    architect: `Design the change: files to touch, contracts, risks. Output a numbered implementation plan as tasks with explicit file paths.`,
    coder: `Write or edit code using write_file/edit_file tools only after reading the target files. Keep diffs minimal. Verify with run_shell (build/test commands).`,
    verifier: `Verify: run tests/build, inspect changed files with read_file/git_status. Output a strict JSON verdict: {"pass":true|false,"issues":[...],"fixedFiles":[...]}`,
    debugger: `Diagnose failing checks: read logs, run_shell the failing command, fix minimal root cause.`,
    custom: `Follow the task description precisely.`,
};
export function compileSystemPrompt(options: {
    chat?: boolean;
    role?: AgentRole;
    contextText?: string;
    tools: ToolSpec[];
    busSnapshot?: string;
    tokenHint?: string;
}): string {
    const parts: string[] = [options.chat ? CHAT_BASE : `You are a MAD subagent. ${ROLE_GUIDES[options.role ?? 'custom']}`];
    if (options.contextText)
        parts.push(options.contextText);
    if (options.busSnapshot)
        parts.push(`Shared agent log:\n${options.busSnapshot}`);
    if (options.tokenHint)
        parts.push(options.tokenHint);
    if (options.tools.length) {
        parts.push('Tool calls: use native tool calls if your provider supports them; otherwise reply with exactly one JSON object: {"action":{"tool":"<name>","args":{...}}} or {"done":true,"summary":"..."}.');
    }
    return parts.join('\n\n');
}
export function planPrompt(goal: string, contextText: string, verification: string): string {
    return `Goal: ${goal}

${contextText}

${verification ? `Verification command that will be run after implementation: ${verification}` : 'No automated verification command detected.'}

Respond with JSON only:
{
  "answer": "for questions/chats only: a direct answer text; when this is a code task set to null",
  "tasks": [
    {"id":"t1","title":"...","detail":"what to change, file paths","role":"coder|architect|verifier|debugger","dependsOn":["t0","..."]}
  ]
}
Rules:
- ids are t1..tN, first task has no dependsOn.
- include a final verifier task that runs ${verification || 'the detected test command'}.
- complexity below 3 tasks means a single coder task + verifier.`;
}
export function verifyPrompt(): string {
    return `Verify the implemented changes. Read changed files, run the test/build command, then respond with exactly one JSON object:
{"pass":true|false,"issues":["..."],"notes":"..."}`;
}
