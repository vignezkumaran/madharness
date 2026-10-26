import * as path from 'path';
import { PythonAstPruner } from '../ast/index.js';
import { treeSitterContract } from '../ast/tree-sitter-pruner.js';

export interface DistilledFile {
  file: string;
  relativePath: string;
  language: string;
  originalLines: number;
  distilledLines: number;
  originalTokens: number;
  distilledTokens: number;
  savingsPercent: number;
  content: string;
  classes: string[];
  functions: string[];
}

const TOKENS_PER_CHAR = 0.25;

function countTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

function languageOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.py': 'python',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.rb': 'ruby',
    '.json': 'json',
    '.md': 'markdown',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.css': 'css',
    '.html': 'html',
  };
  return map[ext] ?? ext.replace(/^\./, '') ?? 'text';
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function finish(
  relativePath: string,
  language: string,
  original: string,
  distilled: string,
  classes: string[],
  functions: string[]
): DistilledFile {
  const originalLines = original.split('\n').length;
  const distilledLines = distilled.split('\n').length;
  const originalTokens = countTokens(original);
  const distilledTokens = countTokens(distilled);
  const savingsPercent = originalTokens > 0
    ? Math.round(((originalTokens - distilledTokens) / originalTokens) * 1000) / 10
    : 0;

  return {
    file: relativePath,
    relativePath,
    language,
    originalLines,
    distilledLines,
    originalTokens,
    distilledTokens,
    savingsPercent,
    content: distilled,
    classes: unique(classes),
    functions: unique(functions),
  };
}

// ─── JS/TS/JSX/TSX contract extraction ──────────────────────────────────────
// Keeps imports, type/interface/enum declarations, class declarations and
// function/method signatures. Bodies are removed. Multi-line signatures are
// buffered until their opening brace or statement terminator.
// ─────────────────────────────────────────────────────────────────────────────

const SIGNATURE_PATTERNS = [
  /^\s*(import|export)\s/,
  /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+[A-Za-z_$]/,
  /^\s*(export\s+)?(declare\s+)?(interface|type|enum|namespace)\s+[A-Za-z_$]/,
  /^\s*(export\s+)?(const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=/,
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+[A-Za-z_$*]/,
  /^\s*(public|private|protected|static|async|readonly|abstract|override|get|set|\s)*[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?::[^{;]+)?\{?/,
  /^\s*@[A-Za-z_$]/,
];

function looksLikeSignature(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return false;
  if (trimmed.startsWith('return ') || trimmed.startsWith('throw ') || trimmed.startsWith('await ')) return false;
  if (trimmed.startsWith('if (') || trimmed.startsWith('for (') || trimmed.startsWith('while (') || trimmed.startsWith('switch (')) return false;
  if (trimmed === '}' || trimmed === '};' || trimmed === ')' || trimmed === '});') return false;
  return SIGNATURE_PATTERNS.some((pattern) => pattern.test(line));
}

function pruneJsLike(content: string, language: string, absPath: string, relativePath: string): DistilledFile {
  const ast = treeSitterContract(absPath, content);
  if (ast) {
    return finish(relativePath, language, content, ast.content, ast.classes, ast.functions);
  }

  const lines = content.split('\n');
  const out: string[] = [];
  const classes: string[] = [];
  const functions: string[] = [];

  let inBlockComment = false;
  let buffer: string[] | null = null;

  const flush = () => {
    if (!buffer) return;
    const joined = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) out.push(joined);
    buffer = null;
  };

  for (const raw of lines) {
    let line = raw;
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (!trimmed || trimmed.startsWith('//')) continue;

    const classMatch = trimmed.match(/(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
    if (classMatch?.[1]) classes.push(classMatch[1]);

    const fnMatch = trimmed.match(/(?:function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*(?:=|\()/) 
      || trimmed.match(/^\s*(?:public|private|protected|static|async|get|set|\s)*([A-Za-z_$][\w$]*)\s*\(/);
    if (fnMatch?.[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(fnMatch[1])) {
      functions.push(fnMatch[1]);
    }

    if (buffer) {
      buffer.push(trimmed);
      if (trimmed.includes('{') || trimmed.endsWith(';')) flush();
      continue;
    }

    if (!looksLikeSignature(line)) continue;

    if (trimmed.endsWith('{') || trimmed.endsWith(';')) {
      out.push(line.replace(/\s+$/, ''));
    } else {
      buffer = [trimmed];
    }
  }
  flush();

  const distilled = out.join('\n');

  if (distilled.trim().length < 40) {
    const fallback = lines
      .filter((line) => line.trim() && !line.trim().startsWith('//'))
      .slice(0, 60)
      .join('\n');
    return finish(relativePath, language, content, fallback, classes, functions);
  }

  return finish(relativePath, language, content, distilled, classes, functions);
}

function pruneGeneric(content: string, language: string, relativePath: string): DistilledFile {
  const lines = content
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .slice(0, 160);

  return finish(relativePath, language, content, lines.join('\n'), [], []);
}

function prunePython(content: string, absPath: string, relativePath: string): DistilledFile {
  const ast = treeSitterContract(absPath, content);
  if (ast) {
    return finish(relativePath, 'python', content, ast.content, ast.classes, ast.functions);
  }

  const pruner = new PythonAstPruner({
    keepDocstrings: false,
    keepComments: false,
    keepConstants: true,
  });

  const contract = pruner.pruneContent(content, relativePath);
  const distilled = contract.prunedContent.trim()
    ? contract.prunedContent
    : content.split('\n').slice(0, 80).join('\n');

  return finish(
    relativePath,
    'python',
    content,
    distilled,
    contract.classes,
    contract.functions
  );
}

export function distillSource(absPath: string, content: string, root?: string): DistilledFile {
  const relativePath = root ? path.relative(root, absPath) : absPath;
  const language = languageOf(absPath);

  if (language === 'python') return prunePython(content, absPath, relativePath);
  if (['typescript', 'tsx', 'javascript', 'jsx'].includes(language)) {
    return pruneJsLike(content, language, absPath, relativePath);
  }
  return pruneGeneric(content, language, relativePath);
}
