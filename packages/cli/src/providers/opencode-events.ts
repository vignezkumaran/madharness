import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomBytes } from 'crypto';
import type { LlmRequest, LlmResult } from './types.js';
import { sseData } from './http.js';
/** Consume OpenCode's live SSE events; `run --format json` only reports finished text parts. */
export class OpenCodeEvents {
    private child: ChildProcessWithoutNullStreams | null = null;
    private starting: Promise<string> | null = null;
    private closed = false;
    private readonly username = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
    private readonly password = process.env.OPENCODE_SERVER_PASSWORD ?? randomBytes(24).toString('hex');
    constructor(private readonly config: () => string) { }
    private start(): Promise<string> {
        if (this.closed)
            return Promise.reject(new Error('OpenCode transport closed'));
        if (process.env.MAD_OPENCODE_SERVER_URL)
            return Promise.resolve(process.env.MAD_OPENCODE_SERVER_URL);
        if (this.starting)
            return this.starting;
        this.starting = new Promise((resolve, reject) => {
            const child = spawn('opencode', ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OPENCODE_CONFIG: this.config(), OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_SERVER_USERNAME: this.username, NO_COLOR: '1' } });
            this.child = child;
            let output = '';
            let errors = '';
            let ready = false;
            const timer = setTimeout(() => { child.kill(); reject(new Error('OpenCode event server startup timed out')); }, 15000);
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => { errors = (errors + chunk).slice(-1500); });
            child.stdout.on('data', (chunk: string) => {
                output += chunk;
                const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
                if (match && !ready) {
                    ready = true;
                    clearTimeout(timer);
                    resolve(match[1]);
                }
            });
            child.on('error', error => { clearTimeout(timer); reject(error); });
            child.on('exit', () => {
                clearTimeout(timer);
                this.child = null;
                this.starting = null;
                if (!ready)
                    reject(new Error(`OpenCode event server exited before startup: ${errors.replace(/(?:sk-|gsk_)[A-Za-z0-9_-]+/g, '[redacted]').slice(-500)}`));
            });
        });
        return this.starting;
    }
    async stream(req: LlmRequest, model: string, onDelta: (text: string) => void): Promise<LlmResult> {
        req.signal?.throwIfAborted();
        const base = await this.start();
        req.signal?.throwIfAborted();
        const directory = req.workspace ?? process.cwd();
        const suffix = `?directory=${encodeURIComponent(directory)}`;
        const headers = { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}` };
        const controller = new AbortController();
        const firstResponse = new AbortController();
        const firstResponseTimer = setTimeout(() => firstResponse.abort(new Error('OpenCode model did not respond within 45 seconds')), 45000);
        const signal = req.signal ? AbortSignal.any([controller.signal, firstResponse.signal, req.signal, AbortSignal.timeout(180000)]) : AbortSignal.any([controller.signal, firstResponse.signal, AbortSignal.timeout(180000)]);
        const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
            const response = await fetch(base + path + suffix, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
            if (!response.ok)
                throw new Error(`OpenCode ${path}: HTTP ${response.status}`);
            return response;
        };
        let completed = false;
        let sessionID: string | undefined;
        const abortRemote = () => {
            if (sessionID && !completed)
                void fetch(base + `/session/${sessionID}/abort` + suffix, { method: 'POST', headers, signal: AbortSignal.timeout(3000) }).catch(() => { });
        };
        signal.addEventListener('abort', abortRemote, { once: true });
        let reading: Promise<void> | undefined;
        const assistantIDs = new Set<string>();
        try {
            const session = await (await request('/session', { title: 'MAD request' })).json() as {
                id: string;
            };
            sessionID = session.id;
            const response = await request('/event');
            let text = '';
            const textParts = new Map<string, string>();
            const pending = new Map<string, Array<{ type: string; properties: any }>>();
            const acceptPart = (event: { type: string; properties: any }) => {
                const p = event.properties;
                if (event.type === 'message.part.delta' && p.field === 'text' && typeof p.delta === 'string') {
                    clearTimeout(firstResponseTimer);
                    textParts.set(p.partID, (textParts.get(p.partID) ?? '') + p.delta);
                    text += p.delta;
                    onDelta(p.delta);
                } else if (event.type === 'message.part.updated' && p.part?.type === 'text' && typeof p.part.text === 'string') {
                    clearTimeout(firstResponseTimer);
                    const previous = textParts.get(p.part.id) ?? '';
                    if (p.part.text.startsWith(previous)) {
                        const delta = p.part.text.slice(previous.length);
                        if (delta) { text += delta; onDelta(delta); }
                    }
                    textParts.set(p.part.id, p.part.text);
                }
            };
            reading = (async () => {
                for await (const raw of sseData(response)) {
                    let event: any;
                    try {
                        event = JSON.parse(raw);
                    }
                    catch {
                        continue;
                    }
                    const p = event.properties ?? {};
                    if (p.sessionID !== sessionID && p.part?.sessionID !== sessionID && p.info?.sessionID !== sessionID)
                        continue;
                    if (event.type === 'message.updated' && p.info?.id) {
                        if (p.info.role === 'assistant') {
                            assistantIDs.add(p.info.id);
                            for (const part of pending.get(p.info.id) ?? []) acceptPart(part);
                        }
                        pending.delete(p.info.id);
                    } else if (event.type === 'message.part.delta' || event.type === 'message.part.updated') {
                        const id = p.messageID ?? p.part?.messageID;
                        if (!id) continue;
                        if (assistantIDs.has(id)) acceptPart(event);
                        else {
                            const parts = pending.get(id) ?? [];
                            if (parts.length < 256) parts.push(event);
                            pending.set(id, parts);
                        }
                    }
                }
            })();
            // Attach a handler immediately: network cancellation must not become an unhandled rejection.
            void reading.catch(() => { });
            const slash = model.indexOf('/');
            const payload = { agent: 'mad-chat', ...(slash > 0 ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {}), system: req.system, tools: { '*': false, bash: false, read: false, glob: false, grep: false, list: false, edit: false, write: false, task: false, webfetch: false, todowrite: false, question: false, skill: false }, parts: [{ type: 'text', text: [req.tools?.length ? `Tool schemas: ${JSON.stringify(req.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })))}` : '', ...req.messages.map(m => `${m.role}${m.name ? ` ${m.name}` : ''}: ${m.content}${m.toolCalls?.length ? `\nCalls: ${JSON.stringify(m.toolCalls)}` : ''}`)].filter(Boolean).join('\n\n') }] };
            const result = await (await request(`/session/${sessionID}/message`, payload)).json() as {
                info?: {
                    error?: unknown;
                    tokens?: {
                        input?: number;
                        output?: number;
                    };
                };
                parts?: Array<{
                    type: string;
                    text?: string;
                }>;
            };
            signal.throwIfAborted();
            if (result.info?.error)
                throw new Error(`OpenCode model request failed: ${JSON.stringify(result.info.error)}`);
            const finalText = (result.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('');
            // Prompt completion can race the last SSE event. Emit only its missing suffix.
            if (finalText.startsWith(text) && finalText.length > text.length)
                onDelta(finalText.slice(text.length));
            const tokens = result.info?.tokens;
            completed = true;
            return { text: finalText || text, toolCalls: [], usage: typeof tokens?.input === 'number' && typeof tokens.output === 'number' ? { input: tokens.input, output: tokens.output } : undefined };
        }
        catch (error) {
            if (!req.signal?.aborted && (firstResponse.signal.aborted || (error as Error).name === 'TimeoutError'))
                throw new Error(`OpenCode model ${model} timed out ${firstResponse.signal.aborted ? 'before its first response (45 seconds)' : 'during the request'}. Try another model with /models.`);
            throw error;
        }
        finally {
            clearTimeout(firstResponseTimer);
            controller.abort();
            await reading?.catch(() => { });
            signal.removeEventListener('abort', abortRemote);
            if (sessionID)
                void fetch(base + `/session/${sessionID}` + suffix, { method: 'DELETE', headers, signal: AbortSignal.timeout(3000) }).catch(() => { });
        }
    }
    close(): void { this.closed = true; this.child?.kill(); this.child = null; }
}
