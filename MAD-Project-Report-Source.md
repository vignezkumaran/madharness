# MAD Harness: Core Algorithms

Complete source of the selected algorithm files. These files depend on other modules in the project.

## AST pruning

### packages/cli/src/ast/tree-sitter-pruner.ts

```typescript
import { createRequire } from 'module';
import * as path from 'path';   

interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  childForFieldName(name: string): TsNode | null;
  namedChildren: TsNode[];
}

interface TsLanguage {
  typescript: unknown;
  tsx: unknown;
}

interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: TsNode };
}

interface Grammars {
  Parser: new () => TsParser;
  Python: unknown;
  TypeScript: TsLanguage;
}

let grammars: Grammars | null | undefined;

function loadGrammars(): Grammars | null {
  if (grammars !== undefined) return grammars;
  try {
    const require = createRequire(import.meta.url);
    grammars = {
      Parser: require('tree-sitter') as new () => TsParser,
      Python: require('tree-sitter-python'),
      TypeScript: require('tree-sitter-typescript') as TsLanguage,
    };
  } catch {
    grammars = null;
  }
  return grammars;
}

export interface TreeSitterContract {
  content: string;
  language: string;
  classes: string[];
  functions: string[];
}

function nameOf(node: TsNode): string {
  return node.childForFieldName('name')?.text ?? '';
}

function indentation(node: TsNode): string {
  return ' '.repeat(node.startPosition.column);
}

function ensureColon(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(':') || trimmed.endsWith(':')) return `${trimmed} ...`;
  return `${trimmed}: ...`;
}

function pythonSignature(node: TsNode, source: string): string {
  const body = node.childForFieldName('body');
  if (!body) return source.slice(node.startIndex, node.endIndex).trimEnd();
  const signature = source.slice(node.startIndex, body.startIndex).trimEnd();
  return ensureColon(signature);
}

function pythonDecorated(node: TsNode, source: string, classes: string[], functions: string[]): string[] {
  const indent = indentation(node);
  const lines: string[] = [];
  let definition: TsNode | null = null;

  for (const child of node.namedChildren) {
    if (child.type === 'decorator') {
      lines.push(`${indent}${child.text.trimEnd()}`);
    } else if (child.type === 'function_definition' || child.type === 'class_definition') {
      definition = child;
    }
  }

  if (!definition) return lines;
  if (definition.type === 'function_definition') {
    const name = nameOf(definition);
    if (name) functions.push(name);
    lines.push(`${indent}${pythonSignature(definition, source)}`);
  } else {
    const rendered = pythonClass(definition, source, classes, functions);
    lines.push(...rendered);
  }
  return lines;
}

function pythonClass(node: TsNode, source: string, classes: string[], functions: string[]): string[] {
  const name = nameOf(node);
  if (name) classes.push(name);

  const body = node.childForFieldName('body');
  if (!body) return [source.slice(node.startIndex, node.endIndex).trimEnd()];

  const header = source.slice(node.startIndex, body.startIndex).trimEnd();
  const lines: string[] = [header];

  for (const child of body.namedChildren) {
    if (child.type === 'function_definition') {
      const method = nameOf(child);
      if (method) functions.push(method);
      lines.push('');
      lines.push(`${indentation(child)}${pythonSignature(child, source)}`);
      continue;
    }
    if (child.type === 'decorated_definition') {
      lines.push('');
      lines.push(...pythonDecorated(child, source, classes, functions));
      continue;
    }
    if (child.type === 'expression_statement') {
      const assignment = child.namedChildren[0];
      const left = assignment?.namedChildren[0];
      const leftName = left?.text.trim() ?? '';
      const keepsConstant = /^[A-Z_][A-Z0-9_]*$/.test(leftName)
        || (assignment?.type === 'assignment' && child.text.includes(':'));
      if (keepsConstant) lines.push(`${indentation(child)}${child.text.trimEnd()}`);
    }
  }

  return lines;
}

function pythonContract(source: string, parser: TsParser, language: unknown): TreeSitterContract {
  parser.setLanguage(language);
  const root = parser.parse(source).rootNode;
  const classes: string[] = [];
  const functions: string[] = [];
  const lines: string[] = [];

  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'import_statement':
      case 'import_from_statement':
      case 'future_import_statement':
        lines.push(node.text.trimEnd());
        break;

      case 'function_definition': {
        const name = nameOf(node);
        if (name) functions.push(name);
        lines.push('');
        lines.push(pythonSignature(node, source));
        break;
      }

      case 'decorated_definition':
        lines.push('');
        lines.push(...pythonDecorated(node, source, classes, functions));
        break;

      case 'class_definition':
        lines.push('');
        lines.push(...pythonClass(node, source, classes, functions));
        break;

      case 'expression_statement': {
        const assignment = node.namedChildren[0];
        const left = assignment?.namedChildren[0];
        const leftName = left?.text.trim() ?? '';
        const keepsConstant = /^[A-Z_][A-Z0-9_]*$/.test(leftName)
          || (assignment?.type === 'assignment' && node.text.includes(':'));
        if (keepsConstant) lines.push(node.text.trimEnd());
        break;
      }

      default:
        break;
    }
  }

  return {
    content: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    language: 'python',
    classes: Array.from(new Set(classes)),
    functions: Array.from(new Set(functions)),
  };
}

function tsSignature(node: TsNode, source: string): string {
  const body = node.childForFieldName('body');
  if (!body) return source.slice(node.startIndex, node.endIndex).trimEnd();
  const signature = source.slice(node.startIndex, body.startIndex).trimEnd();
  return `${signature} { ... }`;
}

function tsClass(node: TsNode, source: string, classes: string[], functions: string[]): string[] {
  const className = nameOf(node);
  if (className) classes.push(className);

  const body = node.childForFieldName('body');
  if (!body) return [source.slice(node.startIndex, node.endIndex).trimEnd()];

  const header = source.slice(node.startIndex, body.startIndex).trimEnd();
  const lines: string[] = [`${header} {`];

  for (const member of body.namedChildren) {
    switch (member.type) {
      case 'method_definition': {
        const method = nameOf(member);
        if (method) functions.push(method);
        lines.push(`${indentation(member)}${tsSignature(member, source)}`);
        break;
      }
      case 'public_field_definition':
      case 'property_signature':
      case 'method_signature':
      case 'abstract_method_signature':
      case 'index_signature':
        lines.push(`${indentation(member)}${member.text.trimEnd()}`);
        break;
      default:
        break;
    }
  }

  lines.push('}');
  return lines;
}

function findArrow(node: TsNode): TsNode | null {
  if (node.type === 'arrow_function') return node;
  for (const child of node.namedChildren) {
    const found = findArrow(child);
    if (found) return found;
  }
  return null;
}

function tsVariable(node: TsNode, source: string, functions: string[]): string | null {
  const arrow = findArrow(node);
  if (arrow) {
    const name = node.namedChildren[0]?.namedChildren[0]?.text ?? '';
    if (name) functions.push(name);
    const body = arrow.childForFieldName('body');
    if (body) {
      const signature = source.slice(node.startIndex, body.startIndex).trimEnd();
      return `${signature} ...`;
    }
  }
  const text = node.text.trimEnd();
  return text.includes('function') || text.includes('=>') || text.length < 240 ? text : null;
}

function tsDeclaration(
  node: TsNode,
  source: string,
  classes: string[],
  functions: string[]
): string[] {
  switch (node.type) {
    case 'class_declaration':
      return tsClass(node, source, classes, functions);

    case 'function_declaration': {
      const name = nameOf(node);
      if (name) functions.push(name);
      return [tsSignature(node, source)];
    }

    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration':
    case 'ambient_declaration':
    case 'module':
      return node.text.trimEnd().split('\n');

    case 'lexical_declaration':
    case 'variable_declaration': {
      const rendered = tsVariable(node, source, functions);
      return rendered ? rendered.split('\n') : [];
    }

    default:
      return [];
  }
}

function tsContract(
  source: string,
  parser: TsParser,
  language: unknown,
  label: string
): TreeSitterContract {
  parser.setLanguage(language);
  const root = parser.parse(source).rootNode;
  const classes: string[] = [];
  const functions: string[] = [];
  const lines: string[] = [];

  for (const node of root.namedChildren) {
    if (node.type === 'import_statement' || node.type === 'import_alias') {
      lines.push(node.text.trimEnd());
      continue;
    }

    if (node.type === 'export_statement') {
      const declaration = node.namedChildren.find((child) =>
        [
          'class_declaration',
          'function_declaration',
          'interface_declaration',
          'type_alias_declaration',
          'enum_declaration',
          'lexical_declaration',
          'variable_declaration',
          'ambient_declaration',
        ].includes(child.type)
      );
      if (!declaration) {
        lines.push(node.text.trimEnd());
        continue;
      }
      const prefix = source.slice(node.startIndex, declaration.startIndex);
      const rendered = tsDeclaration(declaration, source, classes, functions);
      if (rendered.length > 0) lines.push(`${prefix}${rendered[0]}`, ...rendered.slice(1));
      continue;
    }

    const rendered = tsDeclaration(node, source, classes, functions);
    lines.push(...rendered);
  }

  return {
    content: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    language: label,
    classes: Array.from(new Set(classes)),
    functions: Array.from(new Set(functions)),
  };
}

export function treeSitterContract(
  absPath: string,
  source: string
): TreeSitterContract | null {
  const loaded = loadGrammars();
  if (!loaded) return null;

  const ext = path.extname(absPath).toLowerCase();
  const parser = new loaded.Parser();

  try {
    if (ext === '.py') {
      const contract = pythonContract(source, parser, loaded.Python);
      return contract.content.length >= 40 ? contract : null;
    }

    if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
      const contract = tsContract(source, parser, loaded.TypeScript.typescript, 'typescript');
      return contract.content.length >= 40 ? contract : null;
    }

    if (ext === '.tsx') {
      const contract = tsContract(source, parser, loaded.TypeScript.tsx, 'tsx');
      return contract.content.length >= 40 ? contract : null;
    }

    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
      const contract = tsContract(source, parser, loaded.TypeScript.tsx, ext.slice(1));
      return contract.content.length >= 40 ? contract : null;
    }
  } catch {
    return null;
  }

  return null;
}
```

## DAG scheduling

### packages/cli/src/dag/engine.ts

```typescript
import { EventEmitter } from 'events';
import type { DagNode, DagNodeExecutor, DagEvent, DagToolBridge } from './types.js';
import type { DagNodeStatus } from '../protocol/types.js';
export interface DagRunOptions {
    maxParallel: number;
    maxAttemptsPerNode: number;
    signal: AbortSignal;
}
const snapshot = (node: DagNode): DagNode => ({ ...node, dependsOn: [...node.dependsOn] });
const succeeded = (status: DagNodeStatus) => status === 'complete' || status === 'repaired';
export class DagEngine extends EventEmitter {
    private readonly nodes = new Map<string, DagNode>();
    private running = false;
    executor: DagNodeExecutor = async () => { throw new Error('No DAG executor configured'); };
    constructor(nodes: DagNode[] = [], public goal = '') {
        super();
        for (const node of nodes) {
            if (this.nodes.has(node.id))
                throw new Error(`Duplicate DAG node: ${node.id}`);
            this.nodes.set(node.id, snapshot(node));
        }
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const visit = (id: string) => {
            if (visiting.has(id))
                throw new Error(`DAG cycle at ${id}`);
            if (visited.has(id))
                return;
            const node = this.nodes.get(id);
            if (!node)
                throw new Error(`Missing DAG dependency: ${id}`);
            visiting.add(id);
            node.dependsOn.forEach(visit);
            visiting.delete(id);
            visited.add(id);
        };
        this.nodes.forEach(node => visit(node.id));
    }
    emitEvent(event: DagEvent): void { this.emit('event', event); }
    private update(node: DagNode, status: DagNodeStatus, result?: string): void {
        node.status = status;
        if (result !== undefined)
            node.result = result;
        this.emitEvent({ type: status === 'failed' ? 'node-failed' : 'node-updated', nodeId: node.id, node: snapshot(node) });
    }
    get allNodes(): DagNode[] { return [...this.nodes.values()].map(snapshot); }
    node(id: string): DagNode | null { const node = this.nodes.get(id); return node ? snapshot(node) : null; }
    toolBridge(): DagToolBridge {
        return {
            setNodeStatus: (id, status, result, byAgent) => {
                const node = this.nodes.get(id);
                if (!node)
                    return false;
                // Agent reports cannot bypass execution or complete another task.
                if (byAgent) {
                    if (node.status !== 'running' || (node.agent && node.agent !== byAgent))
                        return false;
                    if (result !== undefined)
                        node.result = result;
                    this.emitEvent({ type: 'node-updated', nodeId: id, node: snapshot(node) });
                    return true;
                }
                if (this.running && node.status === 'running')
                    return false;
                this.update(node, status, result);
                return true;
            },
            addNode: (node, byAgent) => {
                if (!node.id.trim() || this.nodes.has(node.id) || node.dependsOn.some(id => !this.nodes.has(id)))
                    return false;
                const added: DagNode = { ...node, dependsOn: [...node.dependsOn], status: 'pending', attempts: 0, byAgent };
                this.nodes.set(node.id, added);
                this.emitEvent({ type: 'node-updated', nodeId: node.id, node: snapshot(added) });
                return true;
            },
            snapshot: () => this.allNodes, goal: () => this.goal,
        };
    }
    async run(options: DagRunOptions): Promise<{
        ok: boolean;
        summary: string;
    }> {
        if (this.running)
            throw new Error('DAG is already running');
        if (!Number.isInteger(options.maxParallel) || options.maxParallel < 1 || !Number.isInteger(options.maxAttemptsPerNode) || options.maxAttemptsPerNode < 1)
            throw new Error('DAG limits must be positive integers');
        this.running = true;
        const inFlight = new Map<string, Promise<void>>();
        try {
            while (!options.signal.aborted) {
                for (const node of this.nodes.values()) {
                    if (inFlight.size >= options.maxParallel)
                        break;
                    if (node.status !== 'pending' && node.status !== 'blocked')
                        continue;
                    if (node.dependsOn.some(id => !succeeded(this.nodes.get(id)!.status) || inFlight.has(id))) {
                        if (node.status !== 'blocked')
                            this.update(node, 'blocked');
                        continue;
                    }
                    node.attempts++;
                    this.update(node, 'running');
                    const job = this.execute(node, options).finally(() => inFlight.delete(node.id));
                    inFlight.set(node.id, job);
                }
                if (!inFlight.size)
                    break;
                await Promise.race(inFlight.values());
            }
            // Do not return while a cancelled executor can still write to the workspace.
            await Promise.allSettled(inFlight.values());
            for (const node of this.nodes.values()) {
                if (node.status === 'pending' || node.status === 'blocked' || node.status === 'running')
                    this.update(node, 'skipped');
            }
            const nodes = this.allNodes;
            const done = nodes.filter(n => succeeded(n.status)).length;
            const ok = nodes.length > 0 && done === nodes.length && !options.signal.aborted;
            const summary = ok ? `DAG complete: ${done} done` : `DAG incomplete: ${done} done, ${nodes.filter(n => n.status === 'failed').length} failed, ${nodes.filter(n => n.status === 'skipped').length} skipped${options.signal.aborted ? ' (cancelled)' : ''}`;
            this.emitEvent({ type: 'finished' });
            return { ok, summary };
        }
        finally {
            this.running = false;
        }
    }
    private async execute(node: DagNode, options: DagRunOptions): Promise<void> {
        try {
            const outcome = await this.executor(snapshot(node), { signal: options.signal, readyDeps: node.dependsOn.map(id => snapshot(this.nodes.get(id)!)) });
            if (options.signal.aborted)
                this.update(node, 'skipped');
            else if (outcome.ok)
                this.update(node, 'complete', outcome.result);
            else
                this.failed(node, outcome.result, options.maxAttemptsPerNode);
        }
        catch (error) {
            if (options.signal.aborted)
                this.update(node, 'skipped');
            else
                this.failed(node, (error as Error).message, options.maxAttemptsPerNode);
        }
    }
    private failed(node: DagNode, result: string, maxAttempts: number): void {
        this.update(node, 'failed', result);
        if (node.attempts < maxAttempts)
            this.update(node, 'pending');
    }
}
```

## Token minimization

### packages/cli/src/tokens/budget.ts

```typescript
import type { ProviderMessage } from '../providers/types.js';
import type { LlmRequest } from '../providers/types.js';
import { estimateTokens } from './estimator.js';
/** Best-effort reservation; provider tokenization and proxy output limits can differ. */
export function reserveTaskTokens(request: LlmRequest, remaining: number): boolean {
    const input = Math.ceil(estimateTokens(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools })) * 1.25);
    const output = Math.min(request.maxTokens ?? 2200, remaining - input);
    if (output < 128) return false;
    request.maxTokens = output;
    return true;
}
const size = (value: unknown) => JSON.stringify(value).length;
function shorten(text: string, limit: number): string {
    if (text.length <= limit)
        return text;
    const marker = '\n[context truncated to fit budget]\n';
    if (limit <= marker.length)
        return marker.slice(0, limit);
    const head = Math.ceil((limit - marker.length) * 0.6);
    return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head));
}
/** Bound history without separating native calls from their result messages. */
export function budgetMessages(messages: ProviderMessage[], charBudget: number): ProviderMessage[] {
    if (charBudget < 128)
        throw new Error('Tool schemas and instructions exceed contextCharBudget; increase the configured budget');
    if (!messages.length)
        return [];
    if (size(messages) <= charBudget)
        return messages.map(message => ({ ...message }));
    const pinned = { ...messages[0], content: shorten(messages[0].content, Math.floor(charBudget / 3)) };
    const groups: ProviderMessage[][] = [];
    for (const message of messages.slice(1)) {
        if (message.role === 'tool' && groups.length)
            groups[groups.length - 1].push({ ...message });
        else
            groups.push([{ ...message }]);
    }
    const tail: ProviderMessage[][] = [];
    let remaining = charBudget - size([pinned]) - 2;
    for (let index = groups.length - 1; index >= 0; index--) {
        const group = groups[index];
        if (size(group) > remaining) {
            const fixed = size(group.map(message => ({ ...message, content: '' })));
            const allowance = remaining - fixed - 16;
            if (allowance < 0) {
                if (index === groups.length - 1 || group.some(message => message.toolCalls?.length) && !tail.some(g => g.some(m => m.role === 'tool')))
                    throw new Error('Latest tool transaction exceeds contextCharBudget; increase the budget');
                break;
            }
            const each = Math.floor(allowance / group.length);
            for (const message of group)
                message.content = shorten(message.content, each);
        }
        if (size(group) > remaining)
            break;
        tail.unshift(group);
        remaining -= size(group) + 1;
    }
    return [pinned, ...tail.flat()];
}
```

### packages/cli/src/tokens/estimator.ts

```typescript
// ─── Token estimation + budgets ─────────────────────────────────────────────
// Single source of truth for char->token math. Prefer real provider usage
// (LlmUsage) whenever reported; estimates are the floor, never celebrated.
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}
export interface ToolBudget {
    /** hard cap in chars for any tool output fed to the model */
    charCap: number;
    /** keep this many leading lines before elision marker */
    headLines: number;
    /** keep this many trailing lines */
    tailLines: number;
}
export const DEFAULT_TOOL_BUDGET: ToolBudget = { charCap: 8000, headLines: 12, tailLines: 8 };
/** Trim a tool result with head/tail preservation and a mid-marker. */
export function truncateOutput(output: string, budget: ToolBudget = DEFAULT_TOOL_BUDGET): {
    text: string;
    truncated: boolean;
    totalLines: number;
} {
    const lines = output.split('\n');
    const totalLines = lines.length;
    if (output.length <= budget.charCap)
        return { text: output, truncated: false, totalLines };
    const marker = `\n[… output truncated; ${totalLines} lines, ~${estimateTokens(output)} tokens total …]\n`;
    const cap = Math.max(0, budget.charCap);
    if (cap <= marker.length)
        return { text: marker.slice(0, cap), truncated: true, totalLines };
    const available = cap - marker.length;
    const headCap = Math.ceil(available * 0.6);
    const tailCap = available - headCap;
    const head = lines.slice(0, budget.headLines).join('\n').slice(0, headCap);
    const tail = tailCap ? lines.slice(-budget.tailLines).join('\n').slice(-tailCap) : '';
    return { text: head + marker + tail, truncated: true, totalLines };
}
function omitMarker(omitted: number, chars: number): string {
    return `[… ${omitted} lines elided (~${tokensShorthand(chars)})]`;
}
function tokensShorthand(chars: number): string {
    const t = Math.max(1, Math.round(chars / 4));
    return t >= 1000 ? `${Math.round(t / 100) / 10}k tokens` : `${t} tokens`;
}
export type UsageKind = 'turn' | 'tool' | 'compaction';
export interface UsageRecord {
    kind: UsageKind;
    input: number;
    output: number;
    at: number;
}
/** Usage ledger: real numbers first; estimates flagged so dashboards never lie. */
export class UsageLedger {
    private readonly real: Array<{
        record: UsageRecord;
        estimated: boolean;
    }> = [];
    private cachedIsh = 0;
    addRecord(kind: UsageKind, input: number, output: number, estimatedFallback = false): void {
        this.real.push({ record: { kind, input, output, at: Date.now() }, estimated: estimatedFallback });
    }
    /** Return totals, including a `estimatedRatio` so callers can show confidence. */
    totals(): {
        input: number;
        output: number;
        total: number;
        estimated: boolean;
        recent: UsageRecord[];
    } {
        let input = 0;
        let output = 0;
        let estimated = false;
        for (const { record, estimated: wasEstimate } of this.real) {
            input += record.input;
            output += record.output;
            if (wasEstimate)
                estimated = true;
        }
        return { input, output, total: input + output, estimated, recent: this.real.slice(-20).map(({ record }) => record) };
    }
    setCacheHint(tokens: number): void {
        this.cachedIsh = tokens;
    }
    get cacheHint(): number {
        return this.cachedIsh;
    }
}
```

### packages/cli/src/tokens/tool-exposure.ts

```typescript
import type {Tool} from '../tools/types.js';
const deferred=new WeakSet<Tool>();
const discovered=new WeakMap<Tool,number>();
let sequence=0;
/** MAD-specific on-demand schema budgeting; runtime tools remain registered. */
export function registerExposure(tool:Tool):void {if(tool.spec.exposure==='deferred')deferred.add(tool);}
export function exposeTool(tool:Tool):void {
    if(!deferred.has(tool))return;
    discovered.set(tool,++sequence);
    tool.spec={...tool.spec,exposure:'direct'};
}
export function visibleTools(tools:Tool[],maxDiscovered=5,charBudget=6000):Tool[] {
    const direct=tools.filter(tool=>!deferred.has(tool)&&tool.spec.exposure==='direct');
    const candidates=tools.filter(tool=>deferred.has(tool)&&discovered.has(tool)).sort((a,b)=>discovered.get(b)!-discovered.get(a)!);
    let chars=0;const selected:Tool[]=[];
    for(const tool of candidates) {
        if(selected.length>=maxDiscovered)break;
        const size=JSON.stringify(tool.spec.parameters).length+tool.spec.name.length+tool.spec.description.length;
        if(selected.length&&chars+size>charBudget)continue;
        selected.push(tool);chars+=size;
    }
    return [...direct,...selected];
}
export function resetExposure(tools:Tool[]):void {
    for(const tool of tools)if(deferred.has(tool)){discovered.delete(tool);tool.spec={...tool.spec,exposure:'deferred'};}
}
export function undiscoveredTools(tools:Tool[]):Tool[] {
    const visible=new Set(visibleTools(tools));
    return tools.filter(tool=>deferred.has(tool)&&!visible.has(tool));
}
```

## Tool calling

### packages/cli/src/agent/step.ts

```typescript
import {randomUUID} from 'crypto';
import type {Event} from '../protocol/types.js';
import type {LlmRequest,LlmResult,ProviderClient} from '../providers/types.js';
import {assistantTextStream} from '../providers/text-stream.js';
import {estimateTokens} from '../tokens/estimator.js';
import {parseAgentReply} from './protocol.js';

/** Shared sampling boundary for foreground turns and named/DAG workers. */
export async function sampleStep(options:{client:ProviderClient;request:LlmRequest;emit:(event:Event)=>void;streamId?:string;agent?:string}):Promise<LlmResult> {
    const streamId=options.streamId??randomUUID();
    const publish=(text:string|null)=>options.emit({kind:'delta',text,streamId,...(options.agent?{toolLabel:options.agent}:{})});
    publish(null);
    const reveal=assistantTextStream(publish);
    let result:LlmResult;
    try { result=await options.client.stream(options.request,text=>{if(text)reveal(text);}); }
    catch (error) {
        if (!options.request.signal?.aborted && (error as Error).name === 'TimeoutError')
            throw new Error(`${options.client.name} model ${options.client.defaultModel()} timed out. Try another model or provider.`);
        throw error;
    }
    options.request.signal?.throwIfAborted();
    if(!result.toolCalls.length) {
        const reply=parseAgentReply(result.text);
        if(reply.kind==='action'&&reply.action)result.toolCalls=[{id:randomUUID(),name:reply.action.tool,args:JSON.stringify(reply.action.args)}];
    }
    if(!result.usage)result.usage={input:estimateTokens(JSON.stringify({system:options.request.system,messages:options.request.messages,tools:options.request.tools})),output:estimateTokens(result.text),estimated:true};
    return result;
}
```

### packages/cli/src/tools/registry.ts

```typescript
// ─── Tool registry: name -> runtime + spec + exposure ───────────────────────
import type { ToolSpec, ResponseItem } from '../protocol/types.js';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { withWorkspaceLock } from './lock.js';
import { validateArguments } from './validate.js';
import {registerExposure,exposeTool,visibleTools,resetExposure,undiscoveredTools} from '../tokens/tool-exposure.js';
import { ToolError } from './types.js';
export class ToolRegistry {
    private readonly tools = new Map<string, Tool>();
    register(command: Tool): void {
        if (this.tools.has(command.spec.name)) {
            throw new Error(`Tool already registered: ${command.spec.name}`);
        }
        registerExposure(command);
        this.tools.set(command.spec.name, command);
    }
    get(name: string): Tool | null {
        return this.tools.get(name) ?? null;
    }
    has(name: string): boolean {
        return this.tools.has(name);
    }
    /** Direct-exposure specs (fed to the model). */
    listDirect(): ToolSpec[] {
        return visibleTools([...this.tools.values()]).map(tool=>tool.spec);
    }
    /** All specs incl. deferred (used by tool search). */
    listAll(): ToolSpec[] {
        return Array.from(this.tools.values()).map((tool) => tool.spec);
    }
    /** Deferred only — surfaced through tool_search to save prompt tokens. */
    listDeferred(): ToolSpec[] {
        return undiscoveredTools([...this.tools.values()]).map(tool=>tool.spec);
    }
    listTools(): Tool[] { return [...this.tools.values()]; }
    expose(name: string): void {
        const tool = this.tools.get(name);
        if(tool)exposeTool(tool);
    }
    resetDiscovery():void {resetExposure([...this.tools.values()]);}
    names(): string[] {
        return Array.from(this.tools.keys());
    }
    async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const tool = this.tools.get(name);
        if (!tool)
            return { ok: false, output: `Unknown tool: ${name}` };
        if (ctx.signal.aborted)
            return { ok: false, output: 'Cancelled' };
        const validation = validateArguments(args, tool.spec.parameters);
        if (validation)
            return { ok: false, output: `Invalid arguments: ${validation}` };
        const isObjectRecord = Boolean(args) && typeof args === 'object' && !Array.isArray(args);
        const safeArgs = (isObjectRecord ? args : {}) as Record<string, unknown>;
        ctx.emit({
            kind: 'tool-started',
            tool: name,
            brief: describeCall(tool.spec, safeArgs),
            agent: ctx.agent,
        });
        const started = Date.now();
        try {
            const result = await (tool.spec.mutates ? withWorkspaceLock(ctx.workspace, ctx.signal, () => tool.run(safeArgs, ctx)) : tool.run(safeArgs, ctx));
            ctx.emit({
                kind: 'tool-completed',
                tool: name,
                brief: describeCall(tool.spec, safeArgs),
                ok: result.ok,
                detail: result.denied ? 'denied' : undefined,
                agent: ctx.agent,
            });
            void started;
            return result;
        }
        catch (error) {
            const message = error instanceof ToolError ? error.message : `${(error as Error)?.message ?? String(error)}`;
            ctx.emit({
                kind: 'tool-completed',
                tool: name,
                brief: describeCall(tool.spec, safeArgs),
                ok: false,
                detail: message.slice(0, 200),
                agent: ctx.agent,
            });
            return { ok: false, output: `Error: ${message}` };
        }
    }
}
export function describeCall(spec: ToolSpec, args: Record<string, unknown>): string {
    const first = spec.parameters.required?.[0] ?? Object.keys(spec.parameters.properties)[0];
    const value = first !== undefined ? String(args[first] ?? '') : '';
    const secondary = Object.entries(args)
        .filter(([key]) => key !== first && typeof value !== 'undefined' && args[key] !== undefined)
        .slice(0, 1)
        .map(([key, argValue]) => `${key}=${String(argValue).slice(0, 40)}`);
    return [spec.description.split('.')[0], value.slice(0, 60), ...secondary]
        .filter(Boolean)
        .join(' ');
}
```
