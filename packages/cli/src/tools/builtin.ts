// ─── Built-in tools: files, search, shell, git, distill ─────────────────────
import { cloneTool } from './clone.js';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { createInterface } from 'readline';
import * as path from 'path';
import type { Risk, ToolSpec } from '../protocol/types.js';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { classifyRisk } from './approvals.js';
import { truncateOutput, DEFAULT_TOOL_BUDGET } from '../tokens/estimator.js';
import { collectRepoContext } from '../agent/context.js';
import { distillSource } from '../agent/distill.js';
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
export const IGNORED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
    '.cache', '__pycache__', '.venv', 'venv', 'env', 'target', '.lightning',
    '.idea', '.vscode', '.turbo', '.parcel-cache', 'vendor',
]);
const READ_BUDGET = 512000;
function spec(name: string, description: string, properties: ToolSpec['parameters']['properties'], opts: {
    required?: string[];
    exposure?: ToolSpec['exposure'];
    readOnly: boolean;
    mutates: boolean;
}): ToolSpec {
    return {
        name,
        description,
        parameters: { type: 'object', properties, ...(opts.required ? { required: opts.required } : {}) },
        exposure: opts.exposure ?? 'direct',
        readOnly: opts.readOnly,
        mutates: opts.mutates,
    };
}
// ─── Workspace jail ─────────────────────────────────────────────────────────
export function safePath(workspace: string, requested: unknown, fullAccess = false): string {
    const raw = String(requested ?? '.');
    const absolute = path.resolve(workspace, raw);
    const root = fs.realpathSync(workspace);
    let ancestor = absolute;
    const suffix: string[] = [];
    while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor)
            throw new Error(`Invalid path: ${raw}`);
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
    }
    const resolved = path.resolve(fs.realpathSync(ancestor), ...suffix);
    if (!fullAccess && resolved !== root && !resolved.startsWith(root + path.sep))
        throw new Error(`Path escapes workspace: ${raw}`);
    return resolved;
}
/** Central gate: returns true when denied (callers stop politely). */
async function gate(ctx: ToolContext, request: {
    tool: string;
    brief: string;
    risk: Risk;
}): Promise<boolean> {
    if (ctx.signal.aborted)
        return true;
    const decision = await ctx.requestApproval(request);
    if (decision === 'denied')
        return true;
    return ctx.signal.aborted;
}
// ─── Read-only file tools ───────────────────────────────────────────────────
const read_file: Tool = {
    spec: spec('read_file', 'Read a file, optionally selecting a line range to reduce context.', { path: { type: 'string', description: 'file path relative to workspace' }, start_line: { type: 'integer', minimum: 1, description: 'First line (1-based)' }, end_line: { type: 'integer', minimum: 1, description: 'Last line, inclusive; default 200 lines from start' } }, { required: ['path'], readOnly: true, mutates: false }),
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const file = safePath(ctx.workspace, args.path, ctx.fullAccess);
        if (!fs.existsSync(file))
            return { ok: false, output: `No such file: ${args.path}` };
        const stat = fs.statSync(file);
        if (!stat.isFile())
            return { ok: false, output: `Not a file: ${args.path}` };
        if (args.start_line !== undefined || args.end_line !== undefined) {
            const start = Number(args.start_line ?? 1);
            const end = Number(args.end_line ?? start + 199);
            if (end < start)
                return { ok: false, output: 'end_line must be >= start_line' };
            const stream = fs.createReadStream(file, { encoding: 'utf8', signal: ctx.signal });
            const reader = createInterface({ input: stream, crlfDelay: Infinity });
            const selected: string[] = [];
            let lineNumber = 0;
            let chars = 0;
            try {
                for await (const line of reader) {
                    ctx.signal.throwIfAborted();
                    lineNumber++;
                    if (lineNumber < start)
                        continue;
                    if (line.includes('\u0000'))
                        return { ok: false, output: 'Binary file not shown' };
                    selected.push(line);
                    chars += line.length + 1;
                    if (lineNumber >= end || chars >= READ_BUDGET)
                        break;
                }
            }
            finally {
                reader.close();
                stream.destroy();
            }
            const output = truncateOutput(selected.join('\n'));
            return { ok: true, output: `Lines ${start}-${Math.max(start, lineNumber)}:\n${output.text}` };
        }
        if (stat.size > READ_BUDGET) {
            const chunk = fs.readFileSync(file, 'utf8').slice(0, READ_BUDGET);
            return { ok: true, output: `${truncateOutput(chunk).text}\n(file is ${stat.size} bytes; use line ranges for other sections)` };
        }
        const content = fs.readFileSync(file, 'utf8');
        if (content.includes('\u0000'))
            return { ok: false, output: 'Binary file not shown' };
        const trimmed = truncateOutput(content);
        return { ok: true, output: trimmed.text + (trimmed.truncated ? `\n(${trimmed.totalLines} lines total, middle elided)` : '') };
    },
};
const list_files: Tool = {
    spec: spec('list_files', 'List directory entries from the workspace.', { path: { type: 'string', description: 'directory relative to workspace (default .)' } }, { readOnly: true, mutates: false }),
    async run(args, ctx): Promise<ToolResult> {
        const dir = safePath(ctx.workspace, args.path ?? '.', ctx.fullAccess);
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const rows = entries
            .filter((entry) => !IGNORED_DIRS.has(entry.name))
            .map((entry) => `${entry.isDirectory() ? 'd ' : '  '}${entry.name}`);
        return { ok: true, output: rows.join('\n') || '(empty)' };
    },
};
const glob_files: Tool = {
    spec: spec('glob_files', 'Find files by substring pattern.', { pattern: { type: 'string', description: 'substring to match against file names' } }, { required: ['pattern'], readOnly: true, mutates: false }),
    async run(args, ctx): Promise<ToolResult> {
        const perPattern = String(args.pattern ?? '').toLowerCase();
        const found: string[] = [];
        const walk = (dir: string, depth: number): void => {
            if (found.length >= 120 || depth > 5)
                return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const file = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (IGNORED_DIRS.has(entry.name))
                        continue;
                    walk(file, depth + 1);
                }
                else if (entry.name.toLowerCase().includes(perPattern)) {
                    found.push(path.relative(ctx.workspace, file));
                }
            }
        };
        walk(ctx.workspace, 0);
        return { ok: true, output: found.join('\n') || '(no matches)' };
    },
};
const search_files: Tool = {
    spec: spec('search_files', 'Ripgrep-style content search across the workspace.', { pattern: { type: 'string', description: 'regex or plain text' }, limit: { type: 'number', description: 'max match count line cap (default 30)' } }, { required: ['pattern'], readOnly: true, mutates: false }),
    async run(args, ctx): Promise<ToolResult> {
        const pattern = String(args.pattern ?? '');
        const limit = String(Math.min(Number(args.limit ?? 30), 100));
        try {
            const { stdout } = await execFileAsync('rg', ['-n', '--color', 'never', '-m', limit, '-e', pattern, '.'], {
                cwd: ctx.workspace,
                timeout: 15000,
                maxBuffer: 2 * 1024 * 1024,
            });
            const trimmed = truncateOutput(stdout);
            return { ok: true, output: trimmed.text };
        }
        catch (error) {
            if ((error as {
                code?: number;
            }).code === 1)
                return { ok: true, output: '(no matches)' };
            // rg missing entirely: fall back to grep
            const { stdout } = await execFileAsync('grep', ['-rn', '-m', '1', '-e', pattern, '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=.git', '.'], { cwd: ctx.workspace, timeout: 20000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
            const trimmed = truncateOutput(stdout);
            return { ok: true, output: trimmed.text };
        }
    },
};
const git_status: Tool = {
    spec: spec('git_status', 'Show git working tree status.', {}, { readOnly: true, mutates: false }),
    async run(_args, ctx): Promise<ToolResult> {
        return { ok: true, output: await runGit(ctx.workspace, ['status', '--short']) };
    },
};
const git_diff: Tool = {
    spec: spec('git_diff', 'Show uncommitted diff (optionally for one path).', { path: { type: 'string' } }, { readOnly: true, mutates: false }),
    async run(args, ctx): Promise<ToolResult> {
        const target = args.path ? [String(args.path)] : [];
        const statLine = await runGit(ctx.workspace, ['diff', '--stat', ...target]);
        const bodyLine = await runGit(ctx.workspace, ['diff', ...target]);
        const trimmed = truncateOutput(`${statLine}\n${bodyLine}`, { ...DEFAULT_TOOL_BUDGET, charCap: DEFAULT_TOOL_BUDGET.charCap * 2 });
        return { ok: true, output: trimmed.text };
    },
};
async function runGit(cwd: string, args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', args, { cwd, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
        return stdout;
    }
    catch (error) {
        return `git error: ${(error as {
            stderr?: string;
        }).stderr ?? String(error)}`;
    }
}
// ─── Mutable tools ──────────────────────────────────────────────────────────
const write_file: Tool = {
    spec: spec('write_file', 'Create or overwrite a file inside the workspace.', { path: { type: 'string', description: 'file path relative to workspace' }, content: { type: 'string', description: 'full file content' } }, { required: ['path', 'content'], readOnly: false, mutates: true }),
    async run(args, ctx): Promise<ToolResult> {
        const file = safePath(ctx.workspace, args.path, ctx.fullAccess);
        const denied = await gate(ctx, classifyRisk('write_file', { path: file }));
        if (denied)
            return { ok: false, output: `denied writing ${file}`, denied: true };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(args.content ?? ''));
        return { ok: true, output: `wrote ${path.relative(ctx.workspace, file)} (${String(args.content ?? '').split('\n').length} lines)` };
    },
};
const edit_file: Tool = {
    spec: spec('edit_file', 'Replace an exact snippet in a file (must match exactly once).', { path: { type: 'string' }, old: { type: 'string', description: 'exact text to find' }, new: { type: 'string', description: 'replacement text' } }, { required: ['path', 'old', 'new'], readOnly: false, mutates: true }),
    async run(args, ctx): Promise<ToolResult> {
        const file = safePath(ctx.workspace, args.path, ctx.fullAccess);
        if (!fs.existsSync(file))
            return { ok: false, output: `No such file: ${args.path}` };
        const original = fs.readFileSync(file, 'utf8');
        const occurrences = original.split(String(args.old ?? '')).length - 1;
        if (occurrences !== 1) {
            return { ok: false, output: `edit failed: "${String(args.old ?? '').slice(0, 50)}" matches ${occurrences} times — need exactly 1` };
        }
        const denied = await gate(ctx, classifyRisk('edit_file', { path: file }));
        if (denied)
            return { ok: false, output: `denied editing ${file}`, denied: true };
        fs.writeFileSync(file, original.replace(String(args.old ?? ''), String(args.new ?? '')));
        return { ok: true, output: `edited ${path.relative(ctx.workspace, file)}` };
    },
};
const run_shell: Tool = {
    spec: spec('run_shell', 'Execute a shell command in the workspace and return combined output.', { command: { type: 'string', description: 'command to run' }, timeoutMs: { type: 'number', description: 'timeout in ms, default 120000, max 300000' } }, { required: ['command'], readOnly: false, mutates: true }),
    async run(args, ctx): Promise<ToolResult> {
        const command = String(args.command ?? '').trim();
        if (!command)
            return { ok: false, output: 'empty command' };
        const classified = classifyRisk('run_shell', { command });
        const timeoutMs = Math.min(Number(args.timeoutMs ?? 120000), 300000);
        const denied = await gate(ctx, classified);
        if (denied)
            return { ok: false, output: `command denied: ${classified.brief}`, denied: true };
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: ctx.workspace,
                timeout: timeoutMs,
                maxBuffer: 4 * 1024 * 1024,
                signal: ctx.signal,
            });
            const combined = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`;
            const trimmed = truncateOutput(combined);
            return { ok: true, output: trimmed.text + (trimmed.truncated ? `\n(${trimmed.totalLines} lines total)` : '') };
        }
        catch (error) {
            const err = error as {
                stdout?: string;
                stderr?: string;
                killed?: boolean;
                message?: string;
            };
            if (err.killed)
                return { ok: false, output: `command timed out after ${timeoutMs}ms` };
            const output = `${err.stdout ?? ''}${err.stderr ? `\n[stderr]\n${err.stderr}` : ''}`.trim();
            const trimmed = truncateOutput(output || err.message || 'command failed');
            return { ok: false, output: trimmed.text };
        }
    },
};
// ─── Distill (MAD's AST-aware compression as a tool) ────────────────────────
const distill_file: Tool = {
    spec: spec('distill_file', 'Reduce a source file to its interface contract (imports/types/signatures) to save tokens.', { path: { type: 'string', description: 'file path relative to workspace' } }, { required: ['path'], readOnly: true, mutates: false }),
    async run(args, ctx): Promise<ToolResult> {
        const file = safePath(ctx.workspace, args.path, ctx.fullAccess);
        if (!fs.existsSync(file))
            return { ok: false, output: `No such file: ${args.path}` };
        const content = fs.readFileSync(file, 'utf8');
        const distilled = distillSource(file, content, ctx.workspace);
        return {
            ok: true,
            output: `### ${distilled.relativePath} (${distilled.language}) — ${distilled.savingsPercent}% distilled\n${distilled.content}`,
        };
    },
};
const repo_context: Tool = {
    spec: spec('repo_context', 'Get relevant distilled repository context. Call only when project structure or related code is needed.', { query: { type: 'string' } }, { required: ['query'], readOnly: true, mutates: false }),
    async run(args, ctx) { const context = await collectRepoContext(ctx.workspace, String(args.query)); return { ok: true, output: context.text }; }
};
// ─── Registry assembly ──────────────────────────────────────────────────────
export const BUILTIN_TOOLS: Tool[] = [
    cloneTool(safePath),
    repo_context,
    read_file,
    list_files,
    glob_files,
    search_files,
    git_status,
    git_diff,
    distill_file,
    write_file,
    edit_file,
    run_shell,
];
