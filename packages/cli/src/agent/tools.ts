import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AgentRole,
  ApprovalDecision,
  ApprovalRequest,
  ApproveFn,
  BusKind,
  ToolOutcome,
} from './types.js';
import { distillSource } from './distill.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_READ_CHARS = 48_000;
const MAX_TOOL_OUTPUT = 20_000;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.cache', '__pycache__', '.venv', 'venv', 'env', 'target', '.lightning',
  '.idea', '.vscode', '.turbo', '.parcel-cache', 'vendor',
]);

export interface ToolSpec {
  name: string;
  description: string;
  input: string;
  readOnly: boolean;
  roles: AgentRole[];
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 file from the workspace. Prefer this over guessing file contents.',
    input: '{"path":"relative/path","offset":1,"limit":250}',
    readOnly: true,
    roles: ['architect', 'coder', 'verifier', 'researcher', 'debugger'],
  },
  {
    name: 'list_files',
    description: 'List files and directories under a path (ignores node_modules, .git, dist, caches).',
    input: '{"path":".","depth":2}',
    readOnly: true,
    roles: ['architect', 'coder', 'verifier', 'researcher', 'debugger'],
  },
  {
    name: 'search_files',
    description: 'Search file contents with ripgrep-compatible regex. Returns file:line matches.',
    input: '{"pattern":"createServer","path":".","include":"*.ts"}',
    readOnly: true,
    roles: ['architect', 'coder', 'verifier', 'researcher', 'debugger'],
  },
  {
    name: 'glob_files',
    description: 'Find files by glob pattern, e.g. "src/**/*.ts" or "**/*.test.ts".',
    input: '{"pattern":"src/**/*.ts"}',
    readOnly: true,
    roles: ['architect', 'coder', 'verifier', 'researcher', 'debugger'],
  },
  {
    name: 'distill_file',
    description: 'Compress a file to its interface contract (imports, types, class/function signatures) before reasoning over it.',
    input: '{"path":"src/module.py"}',
    readOnly: true,
    roles: ['architect', 'coder', 'verifier', 'researcher', 'debugger'],
  },
  {
    name: 'git_status',
    description: 'Show git branch and working tree status.',
    input: '{}',
    readOnly: true,
    roles: ['architect', 'coder', 'verifier', 'researcher', 'debugger'],
  },
  {
    name: 'git_diff',
    description: 'Show the current unstaged or staged diff.',
    input: '{"cached":false}',
    readOnly: true,
    roles: ['architect', 'coder', 'verifier', 'researcher', 'debugger'],
  },
  {
    name: 'read_bus',
    description: 'Read the shared agent communication log to see what other agents are doing. Optionally filter by agent id.',
    input: '{"agentId":"optional-agent-id","count":12}',
    readOnly: true,
    roles: ['architect', 'coder', 'verifier', 'researcher', 'debugger'],
  },
  {
    name: 'post_to_bus',
    description: 'Publish a compact handoff, critique, or note to the shared Mesh Bus for other agents.',
    input: '{"kind":"handoff","content":"..."}',
    readOnly: true,
    roles: ['architect', 'coder', 'verifier', 'researcher', 'debugger'],
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file. Requires user approval.',
    input: '{"path":"src/new.ts","content":"full file contents"}',
    readOnly: false,
    roles: ['coder', 'debugger'],
  },
  {
    name: 'edit_file',
    description: 'Replace an exact unique snippet in a file. Requires user approval.',
    input: '{"path":"src/a.ts","find":"old exact text","replace":"new text","all":false}',
    readOnly: false,
    roles: ['coder', 'debugger'],
  },
  {
    name: 'run_shell',
    description: 'Run a shell command in the workspace (tests, builds, installs). Requires user approval.',
    input: '{"command":"npm test","timeoutMs":120000}',
    readOnly: false,
    roles: ['coder', 'verifier', 'debugger'],
  },
];

export interface ToolContext {
  agentId: string;
  role: AgentRole;
  signal?: AbortSignal;
  postToBus?: (kind: BusKind, content: string) => void;
}

export function specsForRole(role: AgentRole): ToolSpec[] {
  return TOOL_SPECS.filter((spec) => spec.roles.includes(role));
}

export function toolPrompt(role: AgentRole): string {
  return specsForRole(role)
    .map((spec) => `- ${spec.name}: ${spec.description}\n  args: ${spec.input}`)
    .join('\n');
}

function clip(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[${text.length - max} chars clipped]`;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safePath(cwd: string, raw: unknown): string {
  const input = String(raw ?? '').trim();
  if (!input) throw new Error('Missing required argument: path');
  const root = path.resolve(cwd);
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isInside(root, abs)) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
  return abs;
}

function rel(cwd: string, abs: string): string {
  return path.relative(path.resolve(cwd), abs) || '.';
}

function warnIfDestructive(command: string): string {
  const risky = /(^|\s)(sudo|rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-fd|mkfs|dd\s+if=|shutdown|reboot|chmod\s+777)(\s|$)/i;
  return risky.test(command) ? ' ⚠ destructive command' : '';
}

class ApprovalQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly approve: ApproveFn) {}

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const next = this.chain.then(() => this.approve(req));
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}

export class Toolbelt {
  private readonly always = new Set<string>();
  private readonly approvals: ApprovalQueue;

  constructor(
    public readonly cwd: string,
    approve: ApproveFn,
    initialAlways: Iterable<string> = []
  ) {
    this.approvals = new ApprovalQueue(approve);
    for (const key of initialAlways) this.always.add(key);
  }

  allows(key: string): boolean {
    return this.always.has(key);
  }

  private async gate(key: string, request: Omit<ApprovalRequest, 'key' | 'id'>): Promise<boolean> {
    if (this.always.has(key)) return true;

    const decision = await this.approvals.request({
      ...request,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      key,
    });

    if (decision === 'always') {
      this.always.add(key);
      return true;
    }
    return decision === 'once';
  }

  async run(name: string, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const spec = TOOL_SPECS.find((item) => item.name === name);
    if (!spec) {
      return { ok: false, output: `Unknown tool "${name}". Available tools: ${specsForRole(ctx.role).map((s) => s.name).join(', ')}` };
    }
    if (!spec.roles.includes(ctx.role)) {
      return { ok: false, output: `Tool "${name}" is not available to the ${ctx.role} role.` };
    }
    if (ctx.signal?.aborted) {
      return { ok: false, output: 'Aborted by user.' };
    }

    try {
      switch (name) {
        case 'read_file':
          return await this.readFile(rawArgs, ctx);
        case 'list_files':
          return await this.listFiles(rawArgs);
        case 'search_files':
          return await this.searchFiles(rawArgs);
        case 'glob_files':
          return await this.globFiles(rawArgs);
        case 'distill_file':
          return await this.distillFile(rawArgs);
        case 'git_status':
          return await this.gitStatus();
        case 'git_diff':
          return await this.gitDiff(rawArgs);
        case 'post_to_bus':
          return this.postToBus(rawArgs, ctx);
        case 'write_file':
          return await this.writeFile(rawArgs, ctx);
        case 'edit_file':
          return await this.editFile(rawArgs, ctx);
        case 'run_shell':
          return await this.runShell(rawArgs, ctx);
        default:
          return { ok: false, output: `Tool not implemented: ${name}` };
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return { ok: false, output: 'Aborted by user.' };
      }
      return { ok: false, output: `Tool error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── Read-only tools ─────────────────────────────────────────────────────

  private async readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const abs = safePath(this.cwd, args.path);
    if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${rel(this.cwd, abs)}` };
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { ok: false, output: `Not a file: ${rel(this.cwd, abs)}` };
    if (stat.size > MAX_FILE_BYTES) {
      return { ok: false, output: `File is too large (${Math.round(stat.size / 1024)} KB). Use search_files or read a smaller range.` };
    }

    const content = fs.readFileSync(abs, 'utf-8');
    if (content.includes('\u0000')) return { ok: false, output: 'Binary file; refusing to read.' };

    const lines = content.split('\n');
    const offset = Math.max(1, Number(args.offset ?? 1) || 1);
    const limit = Math.min(600, Math.max(1, Number(args.limit ?? 260) || 260));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((line, index) => `${offset + index}: ${line}`).join('\n');
    const header = `File: ${rel(this.cwd, abs)} (${lines.length} lines, showing ${offset}-${Math.min(lines.length, offset + limit - 1)})`;

    return { ok: true, output: clip(`${header}\n${numbered}`) };
  }

  private async listFiles(args: Record<string, unknown>): Promise<ToolOutcome> {
    const abs = safePath(this.cwd, args.path ?? '.');
    if (!fs.existsSync(abs)) return { ok: false, output: `Path not found: ${rel(this.cwd, abs)}` };
    const depth = Math.min(4, Math.max(1, Number(args.depth ?? 2) || 2));
    const rows: string[] = [];
    const walk = (dir: string, level: number, prefix: string) => {
      if (rows.length >= 400 || level > depth) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (rows.length >= 400) break;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          rows.push(`${prefix}${entry.name}/`);
          walk(full, level + 1, `${prefix}  `);
        } else {
          rows.push(`${prefix}${entry.name}`);
        }
      }
    };
    walk(abs, 1, '');
    return { ok: true, output: clip(`Workspace: ${rel(this.cwd, abs)}\n${rows.join('\n') || '(empty)'}`) };
  }

  private async searchFiles(args: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) throw new Error('Missing required argument: pattern');
    const abs = safePath(this.cwd, args.path ?? '.');
    const include = args.include ? String(args.include) : undefined;

    try {
      const rgArgs = ['-n', '--no-heading', '--color', 'never', '-m', '80', '-e', pattern];
      if (include) rgArgs.push('-g', include);
      rgArgs.push(path.relative(this.cwd, abs) || '.');
      const { stdout } = await execFileAsync('rg', rgArgs, {
        cwd: this.cwd,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 20_000,
      });
      return { ok: true, output: clip(stdout.trim() || '(no matches)') };
    } catch (err) {
      const e = err as { code?: string; stdout?: string; message?: string };
      if (e.code === 'ENOENT') return this.searchFilesFallback(pattern, abs, include);
      if (e.stdout && String(e.stdout).trim()) return { ok: true, output: clip(String(e.stdout).trim()) };
      return { ok: false, output: `Search failed: ${e.message ?? 'unknown error'}` };
    }
  }

  private searchFilesFallback(pattern: string, abs: string, include?: string): ToolOutcome {
    const regex = new RegExp(pattern);
    const includeRegex = include ? globToRegExp(include) : null;
    const matches: string[] = [];

    const walk = (dir: string) => {
      if (matches.length >= 120) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (matches.length >= 120) break;
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (includeRegex && !includeRegex.test(rel(this.cwd, full))) continue;
        try {
          if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
          const content = fs.readFileSync(full, 'utf-8');
          if (content.includes('\u0000')) continue;
          content.split('\n').forEach((line, index) => {
            if (matches.length < 120 && regex.test(line)) {
              matches.push(`${rel(this.cwd, full)}:${index + 1}:${clip(line, 300)}`);
            }
          });
        } catch {
          // unreadable file: skip
        }
      }
    };
    walk(abs);
    return { ok: true, output: clip(matches.join('\n') || '(no matches)') };
  }

  private async globFiles(args: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) throw new Error('Missing required argument: pattern');

    try {
      const { stdout } = await execFileAsync('rg', ['--files', '-g', pattern], {
        cwd: this.cwd,
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      });
      return { ok: true, output: clip(stdout.trim() || '(no files)') };
    } catch (err) {
      const e = err as { code?: string; stdout?: string };
      if (e.code !== 'ENOENT') {
        if (e.stdout && String(e.stdout).trim()) return { ok: true, output: clip(String(e.stdout).trim()) };
      }
      const regex = globToRegExp(pattern);
      const results: string[] = [];
      const walk = (dir: string) => {
        if (results.length >= 200) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= 200) break;
          if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (regex.test(rel(this.cwd, full))) results.push(rel(this.cwd, full));
        }
      };
      walk(this.cwd);
      return { ok: true, output: clip(results.join('\n') || '(no files)') };
    }
  }

  private async distillFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const abs = safePath(this.cwd, args.path);
    if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${rel(this.cwd, abs)}` };
    const content = fs.readFileSync(abs, 'utf-8');
    const distilled = distillSource(abs, content, this.cwd);
    const header = [
      `Distilled contract: ${distilled.relativePath} (${distilled.language})`,
      `Original: ${distilled.originalLines} lines / ${distilled.originalTokens} tok`,
      `Contract: ${distilled.distilledLines} lines / ${distilled.distilledTokens} tok (${distilled.savingsPercent}% saved)`,
      distilled.classes.length ? `Classes: ${distilled.classes.join(', ')}` : '',
      distilled.functions.length ? `Functions: ${distilled.functions.join(', ')}` : '',
      '---',
    ].filter(Boolean).join('\n');

    return { ok: true, output: clip(`${header}\n${distilled.content}`, 24_000) };
  }

  private async gitStatus(): Promise<ToolOutcome> {
    try {
      const [{ stdout: branch }, { stdout: status }] = await Promise.all([
        execAsync('git branch --show-current', { cwd: this.cwd, timeout: 10_000 }),
        execAsync('git status --short', { cwd: this.cwd, timeout: 10_000 }),
      ]);
      return {
        ok: true,
        output: `Branch: ${branch.trim() || '(detached)'}\n${status.trim() || 'Working tree clean.'}`,
      };
    } catch (err) {
      return { ok: false, output: `Git error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async gitDiff(args: Record<string, unknown>): Promise<ToolOutcome> {
    const cached = Boolean(args.cached);
    try {
      const { stdout } = await execAsync(cached ? 'git diff --cached' : 'git diff', {
        cwd: this.cwd,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 15_000,
      });
      return { ok: true, output: stdout.trim() || 'No diff.' };
    } catch (err) {
      return { ok: false, output: `Git diff error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private postToBus(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const kind = String(args.kind ?? 'note') as BusKind;
    const allowed: BusKind[] = ['thought', 'result', 'handoff', 'critique', 'note', 'summary'];
    const safeKind = allowed.includes(kind) ? kind : 'note';
    const content = String(args.content ?? '').trim();
    if (!content) return { ok: false, output: 'Missing required argument: content' };
    ctx.postToBus?.(safeKind, content.slice(0, 2000));
    return { ok: true, output: `Posted to Mesh Bus as ${safeKind}.` };
  }

  // ── Mutating tools ──────────────────────────────────────────────────────

  private async writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const abs = safePath(this.cwd, args.path);
    const content = String(args.content ?? '');
    const relative = rel(this.cwd, abs);
    const lines = content.split('\n').length;

    const allowed = await this.gate(`write:${abs}`, {
      tool: 'write_file',
      summary: `Write ${relative} (${lines} lines)`,
      detail: content.split('\n').slice(0, 24).join('\n'),
    });
    if (!allowed) return { ok: false, output: `User denied write to ${relative}.` };

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    ctx.postToBus?.('note', `wrote ${relative} (${lines} lines)`);
    return { ok: true, output: `Wrote ${relative} (${lines} lines).`, changedFiles: [relative] };
  }

  private async editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const abs = safePath(this.cwd, args.path);
    const find = String(args.find ?? '');
    const replace = String(args.replace ?? '');
    const all = Boolean(args.all);
    const relative = rel(this.cwd, abs);

    if (!find) return { ok: false, output: 'Missing required argument: find' };
    if (!fs.existsSync(abs)) return { ok: false, output: `File not found: ${relative}` };

    const before = fs.readFileSync(abs, 'utf-8');
    const occurrences = before.split(find).length - 1;
    if (occurrences === 0) {
      return { ok: false, output: `Exact snippet not found in ${relative}. Read the file and copy the exact text.` };
    }
    if (occurrences > 1 && !all) {
      return { ok: false, output: `Snippet occurs ${occurrences} times in ${relative}. Add more context or pass "all": true.` };
    }

    const after = all ? before.split(find).join(replace) : before.replace(find, replace);

    const allowed = await this.gate(`edit:${abs}`, {
      tool: 'edit_file',
      summary: `Edit ${relative}`,
      detail: `FIND:\n${find.split('\n').slice(0, 12).join('\n')}\n\nREPLACE:\n${replace.split('\n').slice(0, 12).join('\n')}`,
    });
    if (!allowed) return { ok: false, output: `User denied edit to ${relative}.` };

    fs.writeFileSync(abs, after, 'utf-8');
    ctx.postToBus?.('note', `edited ${relative}${all ? ` (${occurrences} occurrences)` : ''}`);
    return { ok: true, output: `Edited ${relative}.`, changedFiles: [relative] };
  }

  private async runShell(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const command = String(args.command ?? '').trim();
    if (!command) throw new Error('Missing required argument: command');
    const timeoutMs = Math.min(300_000, Math.max(1_000, Number(args.timeoutMs ?? 120_000) || 120_000));

    const allowed = await this.gate(`shell:${command}`, {
      tool: 'run_shell',
      summary: `Run shell command${warnIfDestructive(command)}`,
      detail: command,
    });
    if (!allowed) return { ok: false, output: 'User denied shell command.' };

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        signal: ctx.signal,
        shell: '/bin/zsh',
      });
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return { ok: true, output: clip(combined || '(command produced no output)') };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      const output = [
        `Command failed${e.code !== undefined ? ` (exit ${e.code})` : ''}: ${command}`,
        e.stdout?.trim() ? `STDOUT:\n${e.stdout.trim()}` : '',
        e.stderr?.trim() ? `STDERR:\n${e.stderr.trim()}` : '',
        !e.stdout && !e.stderr ? e.message ?? 'unknown error' : '',
      ].filter(Boolean).join('\n');
      return { ok: false, output: clip(output) };
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  out += '$';
  return new RegExp(out);
}
