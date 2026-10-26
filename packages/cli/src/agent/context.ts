import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { distillSource } from './distill.js';

const execFileAsync = promisify(execFile);

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.cache', '__pycache__', '.venv', 'venv', 'env', 'target', '.lightning',
  '.idea', '.vscode', '.turbo', '.parcel-cache', 'vendor',
]);

const CODE_EXTENSIONS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.rs', '.java', '.rb', '.c', '.h', '.cpp', '.hpp',
]);

export interface RepoContext {
  text: string;
  files: string[];
  branch: string;
  dirty: boolean;
  testCommand: string | null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 10_000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

function readIfExists(file: string, maxBytes = 32_000): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const content = fs.readFileSync(file, 'utf-8');
    return content.includes('\u0000') ? null : content;
  } catch {
    return null;
  }
}

function tree(cwd: string, depth = 2): string[] {
  const rows: string[] = [];
  const walk = (dir: string, level: number, prefix: string) => {
    if (rows.length >= 180 || level > depth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (rows.length >= 180) break;
      if (entry.name.startsWith('.') && !['.env.example', '.github'].includes(entry.name)) continue;
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name)) continue;
        rows.push(`${prefix}${entry.name}/`);
        walk(path.join(dir, entry.name), level + 1, `${prefix}  `);
      } else {
        rows.push(`${prefix}${entry.name}`);
      }
    }
  };
  walk(cwd, 1, '');
  return rows;
}

function packageSummary(cwd: string): string | null {
  const raw = readIfExists(path.join(cwd, 'package.json'), 200_000);
  if (!raw) return null;
  try {
    const pkg = JSON.parse(raw) as {
      name?: string;
      version?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = Object.entries(pkg.scripts ?? {}).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    return [
      `package.json: ${pkg.name ?? '(unnamed)'}@${pkg.version ?? '0.0.0'}`,
      scripts ? `scripts:\n${scripts}` : '',
      deps.length ? `dependencies: ${deps.slice(0, 40).join(', ')}${deps.length > 40 ? '…' : ''}` : '',
    ].filter(Boolean).join('\n');
  } catch {
    return null;
  }
}

function detectTestCommand(cwd: string): string | null {
  const pkgRaw = readIfExists(path.join(cwd, 'package.json'), 200_000);
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') return 'npm test';
      if (pkg.scripts?.typecheck) return 'npm run typecheck';
      if (pkg.scripts?.build) return 'npm run build';
    } catch {
      // ignore malformed package.json
    }
  }
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'pytest.ini'))) {
    return 'pytest -q';
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go test ./...';
  return null;
}

function mentionedPaths(prompt: string): string[] {
  const matches = prompt.match(/[\w./@-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|toml|go|rs|java|rb|c|h|cpp|hpp)\b/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 8);
}

function keywords(prompt: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'please',
    'make', 'add', 'fix', 'run', 'build', 'create', 'update', 'remove', 'change',
    'should', 'could', 'would', 'need', 'want', 'using', 'file', 'files', 'code',
  ]);
  return Array.from(new Set(
    (prompt.toLowerCase().match(/[a-z_][a-z0-9_-]{3,}/g) ?? [])
      .filter((word) => !stop.has(word))
      .slice(0, 6)
  ));
}

async function searchFiles(cwd: string, term: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'rg',
      ['-l', '--color', 'never', '-m', '1', '-e', term, '.'],
      { cwd, timeout: 8_000, maxBuffer: 512 * 1024 }
    );
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 5);
  } catch {
    return [];
  }
}

function contractBlock(cwd: string, relative: string): string | null {
  const abs = path.resolve(cwd, relative);
  if (!abs.startsWith(path.resolve(cwd))) return null;
  const content = readIfExists(abs);
  if (!content) return null;
  const distilled = distillSource(abs, content, cwd);
  return [
    `### ${distilled.relativePath} (${distilled.language}) — ${distilled.savingsPercent}% distilled`,
    distilled.content.slice(0, 5_000),
  ].join('\n');
}

export async function collectRepoContext(cwd: string, prompt: string): Promise<RepoContext> {
  const branch = await git(cwd, ['branch', '--show-current']);
  const status = await git(cwd, ['status', '--short']);
  const dirty = status.length > 0;

  const parts: string[] = [];
  parts.push(`Workspace: ${path.basename(cwd)} (${cwd})`);
  parts.push(`Git: branch ${branch || '(detached)'} · ${dirty ? 'uncommitted changes present' : 'clean working tree'}`);
  if (dirty) parts.push(`Changed files:\n${status.split('\n').slice(0, 20).join('\n')}`);

  const agentsDoc = readIfExists(path.join(cwd, 'AGENTS.md'), 40_000)
    ?? readIfExists(path.join(cwd, 'CLAUDE.md'), 40_000);
  if (agentsDoc) {
    parts.push(`Project instructions:\n${agentsDoc.slice(0, 4_000)}`);
  }

  const pkg = packageSummary(cwd);
  if (pkg) parts.push(pkg);

  parts.push(`Workspace tree:\n${tree(cwd, 2).join('\n')}`);

  const candidates = new Set<string>();
  for (const relative of mentionedPaths(prompt)) {
    const normalised = relative.replace(/^\.\//, '');
    if (fs.existsSync(path.resolve(cwd, normalised))) candidates.add(normalised);
  }

  for (const term of keywords(prompt)) {
    const found = await searchFiles(cwd, term);
    for (const file of found) {
      if (file.includes('node_modules') || file.includes('.git/')) continue;
      candidates.add(file.replace(/^\.\//, ''));
    }
  }

  const contextFiles: string[] = [];
  let budget = 12_000 - parts.join('\n\n').length;
  for (const relative of Array.from(candidates).slice(0, 6)) {
    if (budget <= 1_000) break;
    const abs = path.resolve(cwd, relative);
    if (!fs.existsSync(abs)) continue;
    const ext = path.extname(abs).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext) && ext !== '.json' && ext !== '.md') continue;

    const block = contractBlock(cwd, relative);
    if (!block) continue;
    const clipped = block.slice(0, Math.max(800, budget));
    parts.push(`Relevant file context:\n${clipped}`);
    contextFiles.push(relative);
    budget -= clipped.length;
  }

  parts.push(
    'Context is intentionally distilled. Use read_file/search_files/list_files for anything else. '
    + 'Never guess file contents or APIs.'
  );

  return {
    text: parts.join('\n\n'),
    files: contextFiles,
    branch,
    dirty,
    testCommand: detectTestCommand(cwd),
  };
}
