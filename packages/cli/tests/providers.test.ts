import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAiCompatClient, anthropicClient, geminiClient } from '../src/providers/client.js';
import { renderMessages, type ProviderMessage } from '../src/providers/types.js';
const messages: ProviderMessage[] = [
    { role: 'user', content: 'read a file' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', args: '{"path":"a.ts"}' }] },
    { role: 'tool', callId: 'call-1', name: 'read_file', content: 'source text' },
];
async function mockFetch(body: unknown, run: (payload: () => any) => Promise<void>, sse = false) {
    const previous = globalThis.fetch;
    let payload: any;
    globalThis.fetch = async (_url, init) => { payload = JSON.parse(String(init?.body)); return new Response(sse ? String(body) : JSON.stringify(body), { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' } }); };
    try {
        await run(() => payload);
    }
    finally {
        globalThis.fetch = previous;
    }
}
test('history retains native tool IDs and excludes empty system messages', () => {
    const rendered = renderMessages('', [{ type: 'assistant-message', content: '', toolRuns: [], toolCalls: messages[1].toolCalls }, { type: 'tool-output', callId: 'call-1', tool: 'read_file', output: 'source text', exitCode: 0 }]);
    assert.equal(rendered[0].toolCalls?.[0].id, 'call-1');
    assert.equal(rendered[1].role, 'tool');
    assert.equal(rendered[1].callId, 'call-1');
});
test('OpenAI serializer sends native call/result messages', async () => {
    await mockFetch({ choices: [{ message: { content: 'done' } }] }, async (payload) => {
        const client = openAiCompatClient({ name: 'test', baseUrl: () => 'http://fixture', key: () => 'fixture', models: [], defaultModel: () => 'fixture' });
        await client.complete({ system: 'instructions', messages });
        assert.equal(payload().messages[2].tool_calls[0].id, 'call-1');
        assert.deepEqual(payload().messages[3], { role: 'tool', tool_call_id: 'call-1', content: 'source text' });
    });
});
test('OpenAI stream aggregates fragmented names, IDs, arguments and usage', async () => {
    const chunks = [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read_', arguments: '{"path":' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'real-id', function: { name: 'file', arguments: '"a.ts"}' } }] } }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }];
    await mockFetch(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n', async () => {
        const c = openAiCompatClient({ name: 'test', baseUrl: () => 'http://fixture', key: () => 'fixture', models: [], defaultModel: () => 'fixture' });
        const response = await c.stream({ system: '', messages: [] }, () => { });
        assert.deepEqual(response.toolCalls, [{ id: 'real-id', name: 'read_file', args: '{"path":"a.ts"}' }]);
        assert.deepEqual(response.usage, { input: 12, output: 4 });
    }, true);
});
test('Anthropic serializer uses tool_use and tool_result blocks', async () => {
    await mockFetch({ content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 12, output_tokens: 3 } }, async (payload) => {
        const c = anthropicClient({ name: 'test', baseUrl: () => 'http://fixture', key: () => 'fixture', models: [], defaultModel: () => 'fixture' });
        const response = await c.complete({ system: 'instructions', messages });
        assert.deepEqual(payload().messages[1].content, [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }]);
        assert.equal(payload().messages[2].content[0].tool_use_id, 'call-1');
        assert.deepEqual(response.usage, { input: 12, output: 3 });
    });
});
test('Anthropic stream retains zero-argument calls and output usage', async () => {
    const chunks = [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-zero', name: 'git_status', input: {} } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }];
    await mockFetch(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join(''), async () => {
        const c = anthropicClient({ name: 'test', baseUrl: () => 'http://fixture', key: () => 'fixture', models: [], defaultModel: () => 'fixture' });
        const response = await c.stream({ system: '', messages: [] }, () => { });
        assert.deepEqual(response.toolCalls, [{ id: 'call-zero', name: 'git_status', args: '{}' }]);
        assert.deepEqual(response.usage, { input: 10, output: 8 });
    }, true);
});
test('Gemini serializer includes named function calls and results', async () => {
    await mockFetch({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }, async (payload) => {
        const c = geminiClient({ name: 'test', key: () => 'fixture', models: [], defaultModel: () => 'fixture' });
        await c.complete({ system: 'instructions', messages });
        assert.deepEqual(payload().contents[1].parts, [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }]);
        assert.deepEqual(payload().contents[2].parts, [{ functionResponse: { name: 'read_file', response: { output: 'source text' } } }]);
    });
});
test('SSE parser handles multiline frames and fragmented UTF-8', async () => {
    const { sseData } = await import('../src/providers/http.js');
    const bytes = new TextEncoder().encode('event: message\r\ndata: {"text":\r\ndata: "café"}\r\n\r\n');
    const body = new ReadableStream({ start(controller) {
            for (const byte of bytes)
                controller.enqueue(new Uint8Array([byte]));
            controller.close();
        } });
    const payloads: string[] = [];
    for await (const payload of sseData(new Response(body)))
        payloads.push(payload);
    assert.deepEqual(payloads, ['{"text":\n"café"}']);
});
