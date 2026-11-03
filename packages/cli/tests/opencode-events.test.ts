import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeEvents } from '../src/providers/opencode-events.js';
import { opencodeClient } from '../src/providers/local-agent.js';
test('an explicitly selected OpenCode model is not overridden or silently rotated', async () => {
    const previousFetch = globalThis.fetch;
    const previousUrl = process.env.MAD_OPENCODE_SERVER_URL;
    const previousModel = process.env.MAD_OPENCODE_MODEL;
    process.env.MAD_OPENCODE_SERVER_URL = 'http://fixture';
    process.env.MAD_OPENCODE_MODEL = 'wrong/override';
    const models: string[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/session') return Response.json({ id: 's' });
        if (pathname === '/event') return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; init!.signal!.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true }); } }));
        if (pathname.endsWith('/message')) { const body = JSON.parse(String(init!.body)); models.push(`${body.model.providerID}/${body.model.modelID}`); return Response.json({ info: { error: 'model unavailable' } }); }
        return Response.json({});
    };
    const provider = opencodeClient(() => 'chosen/model', true);
    try {
        await assert.rejects(provider.stream({ system: '', messages: [] }, () => {}), /unavailable/);
        assert.deepEqual(models, ['chosen/model']);
    } finally {
        await provider.close?.(); globalThis.fetch = previousFetch;
        if (previousUrl === undefined) delete process.env.MAD_OPENCODE_SERVER_URL; else process.env.MAD_OPENCODE_SERVER_URL = previousUrl;
        if (previousModel === undefined) delete process.env.MAD_OPENCODE_MODEL; else process.env.MAD_OPENCODE_MODEL = previousModel;
    }
});
test('OpenCode SSE emits assistant deltas before completion and excludes user echo', async () => {
    const originalFetch = globalThis.fetch;
    const originalURL = process.env.MAD_OPENCODE_SERVER_URL;
    process.env.MAD_OPENCODE_SERVER_URL = 'http://fixture';
    let channel: ReadableStreamDefaultController<Uint8Array>;
    let finished = false;
    let streamedBeforeFinish = false;
    let payload: any;
    const encoder = new TextEncoder();
    const emit = (type: string, properties: any) => channel.enqueue(encoder.encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
    globalThis.fetch = async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/session')
            return Response.json({ id: 'session-test' });
        if (pathname === '/event')
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                    channel = controller;
                    init!.signal!.addEventListener('abort', () => {
                        try {
                            controller.close();
                        }
                        catch { }
                    }, { once: true });
                } }));
        if (pathname.endsWith('/message')) {
            payload = JSON.parse(String(init!.body));
            emit('message.part.updated', { part: { sessionID: 'session-test', messageID: 'user', id: 'user-part', type: 'text', text: 'do not echo this' } });
            emit('message.part.delta', { sessionID: 'session-test', messageID: 'assistant', partID: 'text-1', field: 'text', delta: 'First line\n' });
            emit('message.updated', { info: { sessionID: 'session-test', id: 'assistant', role: 'assistant' } });
            await new Promise(resolve => setTimeout(resolve, 20));
            emit('message.part.delta', { sessionID: 'session-test', messageID: 'assistant', partID: 'text-1', field: 'text', delta: 'Second line' });
            finished = true;
            return Response.json({ info: { tokens: { input: 12, output: 4 } }, parts: [{ type: 'text', text: 'First line\nSecond line' }] });
        }
        return Response.json({});
    };
    const transport = new OpenCodeEvents(() => 'unused');
    const chunks: string[] = [];
    try {
        const result = await transport.stream({ workspace: '/workspace', system: 'short instructions', messages: [{ role: 'user', content: 'test' }] }, 'provider/model', text => {
            chunks.push(text);
            if (!finished)
                streamedBeforeFinish = true;
        });
        assert.equal(streamedBeforeFinish, true);
        assert.equal(chunks.join(''), 'First line\nSecond line');
        assert.equal(result.text, 'First line\nSecond line');
        assert.deepEqual(result.usage, { input: 12, output: 4 });
        assert.equal(payload.tools['*'], false);
    }
    finally {
        transport.close();
        globalThis.fetch = originalFetch;
        if (originalURL === undefined)
            delete process.env.MAD_OPENCODE_SERVER_URL;
        else
            process.env.MAD_OPENCODE_SERVER_URL = originalURL;
    }
});
test('cancelling a streamed request aborts the remote model request instead of leaving it running', async () => {
    const originalFetch = globalThis.fetch;
    const originalURL = process.env.MAD_OPENCODE_SERVER_URL;
    process.env.MAD_OPENCODE_SERVER_URL = 'http://fixture';
    let channel: ReadableStreamDefaultController<Uint8Array>;
    let remoteAborted = false;
    const cancel = new AbortController();
    globalThis.fetch = async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/session')
            return Response.json({ id: 'cancel-session' });
        if (pathname === '/event')
            return new Response(new ReadableStream<Uint8Array>({ start(c) { channel = c; init!.signal!.addEventListener('abort', () => { try {
                    c.close();
                }
                catch { } }, { once: true }); } }));
        if (pathname.endsWith('/abort')) {
            remoteAborted = true;
            return Response.json(true);
        }
        if (pathname.endsWith('/message')) {
            for (const event of [{ type: 'message.updated', properties: { info: { sessionID: 'cancel-session', id: 'a', role: 'assistant' } } }, { type: 'message.part.delta', properties: { sessionID: 'cancel-session', messageID: 'a', partID: 'p', field: 'text', delta: 'start' } }])
                channel.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            await new Promise(resolve => setTimeout(resolve, 20));
            return Response.json({ parts: [{ type: 'text', text: 'start' }] });
        }
        return Response.json({});
    };
    const transport = new OpenCodeEvents(() => 'unused');
    try {
        await assert.rejects(transport.stream({ system: 'test', messages: [], signal: cancel.signal }, 'p/m', () => cancel.abort()), /abort/i);
        assert.equal(remoteAborted, true);
    }
    finally {
        transport.close();
        globalThis.fetch = originalFetch;
        if (originalURL === undefined)
            delete process.env.MAD_OPENCODE_SERVER_URL;
        else
            process.env.MAD_OPENCODE_SERVER_URL = originalURL;
    }
});
