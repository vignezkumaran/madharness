// ─── MCP stdio client: JSON-RPC 2.0 over child process stdio ────────────────
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: {
        [key: string]: unknown;
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
    };
}
export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}
interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: unknown;
}
interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}
interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
export class McpConnection {
    private child: ChildProcessWithoutNullStreams | null = null;
    private buffer = '';
    private nextId = 1;
    private pending = new Map<string, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    private tools: McpToolInfo[] | null = null;
    private closed = false;
    private protocolVersion = '2024-11-05';
    constructor(public readonly serverName: string, private readonly config: McpServerConfig, private readonly onLog: (line: string) => void = () => { }) { }
    isRunning(): boolean {
        return this.child !== null && !this.closed;
    }
    async start(): Promise<void> {
        if (this.closed)
            throw new Error('MCP connection is closed');
        if (this.child)
            return;
        this.child = spawn(this.config.command, this.config.args ?? [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.config.env },
        });
        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', (chunk: string) => this.onLog(`mcp:${this.serverName} stderr ${chunk.trim().slice(0, 200)}`));
        this.child.on('error', (error) => {
            this.onLog(`mcp:${this.serverName} spawn error ${error.message}`);
            this.failPending(error);
        });
        this.child.on('exit', (code) => {
            this.onLog(`mcp:${this.serverName} exited (${code})`);
            this.child = null;
            for (const [, waiter] of this.pending) {
                waiter.reject(new Error(`mcp server ${this.serverName} exited`));
            }
            this.pending.clear();
        });
        this.child.stdin.on('error', error => this.failPending(error));
        this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
        await this.initialize();
    }
    private async initialize(): Promise<void> {
        await this.call('initialize', { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: 'mad-harness', version: '0.3.0' } }, 20000);
        this.notify('notifications/initialized', {});
    }
    private failPending(error: Error): void {
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
    }
    private notify(method: string, params: unknown): void {
        const message: JsonRpcNotification = { jsonrpc: '2.0', method, params };
        this.child?.stdin.write(JSON.stringify(message) + '\n');
    }
    private sendRequest(method: string, params: unknown): {
        id: number;
    } {
        const id = this.nextId++;
        const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        this.child?.stdin.write(JSON.stringify(message) + '\n');
        return { id };
    }
    private call<T>(method: string, params: unknown, timeoutMs = 60000, signal?: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (!this.child || this.closed) {
                reject(new Error(`mcp server ${this.serverName} not running`));
                return;
            }
            if (signal?.aborted) {
                reject(signal.reason);
                return;
            }
            const id = this.nextId++;
            const key = String(id);
            const settle = (error?: Error, value?: unknown) => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', abort);
                this.pending.delete(key);
                if (error)
                    reject(error);
                else
                    resolve(value as T);
            };
            const abort = () => {
                this.notify('notifications/cancelled', { requestId: id, reason: 'Cancelled by user' });
                settle(new Error(`MCP request cancelled (${method})`));
            };
            const timeout = setTimeout(() => settle(new Error(`mcp request timed out (${method})`)), timeoutMs);
            this.pending.set(key, { resolve: value => settle(undefined, value), reject: error => settle(error) });
            signal?.addEventListener('abort', abort, { once: true });
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
                if (error)
                    settle(error);
            });
        });
    }
    private onData(chunk: string): void {
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            newline = this.buffer.indexOf('\n');
            if (!line.startsWith('{'))
                continue;
            let message: JsonRpcMessage | null = null;
            try {
                message = JSON.parse(line) as JsonRpcMessage;
            }
            catch {
                continue;
            }
            if (!message || !('id' in message))
                continue;
            const response = message as JsonRpcResponse;
            const waiter = this.pending.get(String(response.id));
            if (!waiter)
                continue;
            this.pending.delete(String(response.id));
            if (response.error) {
                waiter.reject(new Error(`mcp error ${response.error.code}: ${response.error.message}`));
            }
            else {
                waiter.resolve(response.result);
            }
        }
    }
    async listTools(): Promise<McpToolInfo[]> {
        if (this.tools)
            return this.tools;
        const tools: McpToolInfo[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const result = await this.call<{
                tools?: McpToolInfo[];
                nextCursor?: string;
            }>('tools/list', cursor ? { cursor } : {});
            tools.push(...(result.tools ?? []));
            cursor = result.nextCursor;
            if (cursor) {
                if (seen.has(cursor))
                    throw new Error('MCP tools/list repeated its cursor');
                seen.add(cursor);
            }
        } while (cursor);
        this.tools = tools;
        return tools;
    }
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{
        content: Array<{
            type?: string;
            text?: string;
        }>;
        isError?: boolean;
    }> {
        return this.call<{
            content: Array<{
                type?: string;
                text?: string;
            }>;
            isError?: boolean;
        }>('tools/call', { name, arguments: args }, 60000, signal);
    }
    stop(): void {
        this.closed = true;
        this.failPending(new Error(`mcp server ${this.serverName} stopped`));
        this.child?.kill();
        this.child = null;
    }
}
/** Convert MCP tool:content into a plain string for the model. */
export function mcpContentToText(response: {
    content?: Array<{
        type?: string;
        text?: string;
    }>;
    isError?: boolean;
}): string {
    const parts = response.content ?? [];
    const text = parts.map((part) => part.text ?? '').filter(Boolean).join('\n');
    if (response.isError)
        return `MCP tool error: ${text || '(unknown)'}`;
    return text || '(empty result)';
}
