import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.MAD_HOME = mkdtempSync(join(tmpdir(), 'mad-tests-'));
process.env.XDG_CONFIG_HOME = join(process.env.MAD_HOME, 'config');
const { DagEngine } = await import('../src/dag/engine.js');
const { runWorker } = await import('../src/agent/worker.js');
const { AgentManager } = await import('../src/agents/manager.js');
const { MadSession } = await import('../src/session/session.js');
const { DEFAULT_CONFIG, loadConfig, saveConfig } = await import('../src/config/loader.js');
const { replayResponseItems } = await import('../src/rollout/store.js');
const { Risk } = await import('../src/protocol/types.js');
import type { LlmRequest, LlmResult, ProviderClient } from '../src/providers/types.js';
import type { DagNode } from '../src/dag/types.js';
const workspace = mkdtempSync(join(tmpdir(), 'mad-workspace-'));
const node = (id: string, dependsOn: string[] = []): DagNode => ({ id, title: id, dependsOn, status: 'pending', attempts: 0 });
const result = (text: string): LlmResult => ({ text, toolCalls: [] });
function client(answer: (req: LlmRequest) => Promise<LlmResult> | LlmResult): ProviderClient {
    return { name: 'test', models: [], streaming: true, defaultModel: () => 'test', hasKey: () => true, complete: async (req) => answer(req), stream: async (req, delta) => { const r = await answer(req); delta(r.text, null); return r; } };
}
const worker = (provider: ProviderClient, extra = {}) => runWorker({ role: 'coder', agentName: 'test', task: 'implement', workspace, contextText: '', client: provider, tools: [], signal: new AbortController().signal, emit: () => { }, requestApproval: async () => 'denied', ...extra });
test('DAG honors dependencies and retries a failed node', async () => {
    const engine = new DagEngine([node('a'), node('b', ['a'])]);
    const order: string[] = [];
    let attempts = 0;
    engine.executor = async (n) => { order.push(n.id); return { ok: n.id !== 'a' || ++attempts > 1, result: n.id }; };
    assert.equal((await engine.run({ maxParallel: 3, maxAttemptsPerNode: 2, signal: new AbortController().signal })).ok, true);
    assert.deepEqual(order, ['a', 'a', 'b']);
});
test('DAG rejects missing dependencies, cycles and duplicate IDs', () => {
    assert.throws(() => new DagEngine([node('a', ['missing'])]), /Missing/);
    assert.throws(() => new DagEngine([node('a', ['b']), node('b', ['a'])]), /cycle/);
    assert.throws(() => new DagEngine([node('a'), node('a')]), /Duplicate/);
});
test('aborting an in-flight DAG settles rather than leaving a waiter hanging', async () => {
    const abort = new AbortController();
    const engine = new DagEngine([node('a')]);
    engine.executor = async () => { abort.abort(); return { ok: true, result: '' }; };
    assert.equal((await engine.run({ maxParallel: 1, maxAttemptsPerNode: 1, signal: abort.signal })).ok, false);
});
test('worker exhaustion and cancellation cannot report success', async () => {
    assert.equal((await worker(client(() => result('invalid')), { maxSteps: 1 })).ok, false);
    const abort = new AbortController();
    abort.abort();
    assert.equal((await worker(client(() => result('{"done":true,"summary":"ok"}')), { signal: abort.signal })).ok, false);
});
test('agent task budget stops further model calls after reported usage and reports incomplete work', async () => {
    const requests: LlmRequest[] = [];
    const provider = client(req => {
        requests.push(req);
        return { text: '', toolCalls: [{ id: 'one', name: 'missing', args: '{}' }], usage: { input: 900, output: 100 } };
    });
    const outcome = await worker(provider, { tokenBudget: 1100, maxSteps: 5 });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].maxTokens! < 1100);
    assert.equal(outcome.ok, false);
    assert.match(outcome.summary, /token budget exhausted.*Task incomplete/i);
});
test('foreground task stops at its cumulative budget and reports incomplete work', async () => {
    let calls = 0;
    class BudgetSession extends MadSession {
        override async client() {
            return client(() => { calls++; return { text: '', toolCalls: [{ id: 'one', name: 'missing', args: '{}' }], usage: { input: 4900, output: 100 } }; });
        }
    }
    const session = new BudgetSession({ workspace, config: { ...DEFAULT_CONFIG, autoCompaction: false, agentTaskTokenBudget: 5000 } });
    const events: Array<{ kind: string; message?: string; ok?: boolean }> = [];
    const finished = new Promise<void>(resolve => session.on(event => { events.push(event); if (event.kind === 'turn-ended') resolve(); }));
    session.submit({ kind: 'user-message', text: 'Inspect the project files', workspace, mode: 'agent' });
    await finished;
    assert.equal(calls, 1);
    assert.ok(events.some(event => event.kind === 'error' && /token budget exhausted.*incomplete/i.test(event.message ?? '')));
    assert.ok(events.some(event => event.kind === 'turn-ended' && event.ok === false));
    await session.close();
});
test('current-events questions keep tool access instead of using tool-free explanation mode', async () => {
    const { explanationOnly } = await import('../src/session/intent.js');
    assert.equal(explanationOnly('what is the latest thing in agentic AI?'), false);
    assert.equal(explanationOnly('what is a closure?'), true);
});
test('agent continues from tool results without adding redundant user messages', async () => {
    const requests: LlmRequest[] = [];
    const provider = client(req => {
        requests.push(structuredClone({ ...req, signal: undefined }));
        return requests.length === 1 ? { text: '', toolCalls: [{ id: 'one', name: 'missing', args: '{}' }] } : result('{"done":true,"summary":"finished"}');
    });
    const outcome = await worker(provider);
    assert.equal(outcome.ok, true);
    assert.deepEqual(requests[1].messages.map(message => message.role), ['user', 'assistant', 'tool']);
});
test('worker final completion on the last step succeeds; verifier requires pass=true', async () => {
    assert.equal((await worker(client(() => result('{"done":true,"summary":"ok"}')), { maxSteps: 1 })).ok, true);
    assert.equal((await worker(client(() => result('{"pass":false,"issues":["test failed"]}')), { role: 'verifier' })).ok, false);
    assert.equal((await worker(client(() => result('{"pass":true,"issues":[]}')), { role: 'verifier' })).ok, true);
});
test('named agents stop their actual worker and reject overlapping tasks', async () => {
    let started!: () => void;
    const ready = new Promise<void>(r => started = r);
    const manager = new AgentManager({ workspace, config: DEFAULT_CONFIG, signal: new AbortController().signal, emit: () => { }, requestApproval: async () => 'denied', client: async () => client(req => new Promise((resolve) => { started(); req.signal!.addEventListener('abort', () => resolve(result('{"done":true,"summary":"cancelled"}')), { once: true }); })) });
    await manager.createAgent({ name: 'one', role: 'coder' });
    const running = manager.submitTask('one', 'task');
    await ready;
    await assert.rejects(manager.submitTask('one', 'other'), /already working/);
    manager.stopAgent('one');
    await running;
    assert.equal(manager.list()[0].status, 'stopped');
});
test('session streams, records full conversation and resumes a snapshot', async () => {
    class Session extends MadSession {
        override async client() { return client(() => result('hello')); }
    }
    const session = new Session({ workspace, config: { ...DEFAULT_CONFIG, autoCompaction: false } });
    const events: string[] = [];
    const done = new Promise<void>(resolve => session.on(e => {
        events.push(e.kind);
        if (e.kind === 'turn-ended')
            resolve();
    }));
    session.submit({ kind: 'user-message', text: 'Explain closures', workspace, mode: 'chat' });
    await done;
    const file = session.rollouts.filename!;
    await session.close();
    assert.ok(events.includes('delta'));
    const replay = replayResponseItems(file);
    assert.equal(replay.items.length, 2);
    assert.equal(replay.items[0].type, 'message');
    const next = new Session({ workspace, config: DEFAULT_CONFIG });
    next.resume(file);
    assert.deepEqual(next.context.items, replay.items);
    await next.close();
});
test('cancelling settles pending approval requests', async () => {
    const session = new MadSession({ workspace, config: { ...DEFAULT_CONFIG, approvalPolicy: 'always' } });
    const pending = session.requestApproval({ tool: 'write_file', brief: 'file', risk: Risk.Write });
    session.cancel();
    assert.equal(await pending, 'denied');
    await session.close();
});
test('workspace config resolves against explicit workspace and project saves preserve keys', () => {
    mkdirSync(join(workspace, '.mad'), { recursive: true });
    writeFileSync(join(workspace, '.mad', 'config.json'), JSON.stringify({ maxStepsPerTask: 3, verifyRounds: 1 }));
    assert.equal(loadConfig({}, workspace).config.maxStepsPerTask, 3);
    const old = process.cwd();
    process.chdir(workspace);
    try {
        saveConfig({ verifyRounds: 2 }, 'project');
        assert.equal(JSON.parse(readFileSync(join(workspace, '.mad', 'config.json'), 'utf8')).maxStepsPerTask, 3);
    }
    finally {
        process.chdir(old);
    }
});
test('workflow plans before creating DAG and preserves planner roles', async () => {
    const events: string[] = [];
    const handoffs: Array<{ from: string; to: string; text: string }> = [];
    const requests: LlmRequest[] = [];
    const provider = client(req => {
        requests.push(req);
        if (req.system.includes('MAD planner')) {
            assert.equal(events.includes('dag-created'), false);
            return result(JSON.stringify({ answer: null, tasks: [{ id: 'design', title: 'Review contracts', role: 'architect', dependsOn: [] }, { id: 'code', title: 'Implement', role: 'coder', dependsOn: ['design'] }, { id: 'check', title: 'Check', role: 'verifier', dependsOn: ['code'] }] }));
        }
        if (req.system.includes('Verify:'))
            return result('{"pass":true,"issues":[]}');
        return result('{"done":true,"summary":"completed"}');
    });
    const manager = new AgentManager({ workspace, config: DEFAULT_CONFIG, signal: new AbortController().signal, emit: e => { events.push(e.kind); if (e.kind === 'agent-communication') handoffs.push(e); }, requestApproval: async () => 'denied', client: async () => provider });
    await manager.planTask('Implement a feature', new AbortController().signal);
    assert.equal(requests.length, 1);
    assert.equal((await manager.executePlan(new AbortController().signal)).ok, true);
    assert.ok(requests.some(req => req.system.includes('Design the change')));
    assert.ok(events.includes('dag-node'));
    assert.equal(handoffs.length, 2);
    assert.match(handoffs[0].text, /Review contracts: completed/);
    assert.notEqual(handoffs[0].from, handoffs[0].to);
    assert.deepEqual(manager.activeNodes().map(n => n.status), ['complete', 'complete', 'complete']);
});
test('MCP tools stay deferred until discovered and require approval', async () => {
    const server = join(workspace, 'mcp-fixture.cjs');
    writeFileSync(server, `const readline=require('readline');readline.createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);if(!('id' in req))return;let result={};if(req.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}};if(req.method==='tools/list')result={tools:[{name:'lookup',description:'Lookup fixture information',inputSchema:{type:'object',properties:{query:{type:'string'}}}}]};if(req.method==='tools/call')result={content:[{type:'text',text:'fixture response'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');});`);
    const { McpManager } = await import('../src/mcp/manager.js');
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const mcp = new McpManager();
    const registry = new ToolRegistry();
    try {
        await mcp.start({ ...DEFAULT_CONFIG, mcpServers: { fixture: { command: process.execPath, args: [server] } } }, () => { });
        await mcp.bridgeInto(registry);
        assert.equal(registry.listDirect().length, 0);
        assert.equal(registry.listDeferred().length, 1);
        const name = registry.listDeferred()[0].name;
        registry.expose(name);
        assert.equal(registry.listDirect().length, 1);
        const ctx = { workspace, signal: new AbortController().signal, emit: () => { }, requestApproval: async () => 'denied' as const };
        assert.equal((await registry.execute(name, {}, ctx)).denied, true);
        assert.equal((await registry.execute(name, {}, { ...ctx, requestApproval: async () => 'approved-once' as const })).output, 'fixture response');
    }
    finally {
        mcp.stop();
    }
});
test('invalid plans never become executable fallback tasks', async () => {
    const { buildPlan, normalizePlan } = await import('../src/agent/planner.js');
    for (const raw of [null, { tasks: [] }, { tasks: [{ id: 'a', title: 'task', role: 'coder', dependsOn: ['missing'] }] }, { tasks: [{ id: 'a', title: 'task', role: 'coder', dependsOn: ['a'] }] }])
        assert.throws(() => normalizePlan(raw, 'goal'));
    let attempts = 0;
    await assert.rejects(buildPlan('goal', '', null, client(() => { attempts++; return result('not JSON'); }), new AbortController().signal), /invalid plan/);
    assert.equal(attempts, 2);
});
test('DAG reports cannot complete a blocked dependency or bypass its executor', async () => {
    const engine = new DagEngine([node('a'), node('b', ['a'])]);
    assert.equal(engine.toolBridge().setNodeStatus('b', 'complete', 'claimed', 'agent'), false);
    const seen: string[] = [];
    engine.executor = async (n) => { seen.push(n.id); return { ok: true, result: 'verified' }; };
    assert.equal((await engine.run({ signal: new AbortController().signal, maxParallel: 2, maxAttemptsPerNode: 1 })).ok, true);
    assert.deepEqual(seen, ['a', 'b']);
    const copy = engine.allNodes;
    copy[1].dependsOn.length = 0;
    assert.deepEqual(engine.node('b')!.dependsOn, ['a']);
});
test('cancellation during startup never invokes planner or workers', async () => {
    let calls = 0;
    class Session extends MadSession {
        override async client() { calls++; return client(() => result('unexpected')); }
    }
    const session = new Session({ workspace, config: DEFAULT_CONFIG });
    const done = new Promise<void>(resolve => session.on(e => {
        if (e.kind === 'turn-ended') {
            assert.equal(e.ok, false);
            resolve();
        }
    }));
    session.submit({ kind: 'start-dag', goal: 'task', workspace });
    session.cancel();
    await done;
    await session.close();
    assert.equal(calls, 0);
});
test('stopping a named agent settles its pending approval', async () => {
    let approval!: () => void;
    const ready = new Promise<void>(resolve => approval = resolve);
    class Session extends MadSession {
        override async client() { return client(() => ({ text: '', toolCalls: [{ id: 'call-write', name: 'write_file', args: '{"path":"blocked.txt","content":"do not write"}' }] })); }
    }
    const session = new Session({ workspace, config: { ...DEFAULT_CONFIG, approvalPolicy: 'always', maxStepsPerTask: 1 } });
    session.on(event => {
        if (event.kind === 'approval-requested')
            approval();
    });
    await session.agentManager().createAgent({ name: 'approval-test', role: 'coder' });
    const task = session.agentManager().submitTask('approval-test', 'write');
    await ready;
    session.agentManager().stopAgent('approval-test');
    await task;
    assert.equal(session.agentManager().list()[0].status, 'stopped');
    await session.close();
});
test('mutating tool calls from different registries serialize per workspace', async () => {
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const first = new ToolRegistry();
    const second = new ToolRegistry();
    let active = 0;
    let peak = 0;
    const tool = { spec: { name: 'mutate', description: 'Mutate', parameters: { type: 'object' as const, properties: {} }, exposure: 'direct' as const, readOnly: false, mutates: true }, run: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { ok: true, output: '' }; } };
    first.register(tool);
    second.register(tool);
    const ctx = { workspace, signal: new AbortController().signal, emit: () => { }, requestApproval: async () => 'approved-once' as const };
    await Promise.all([first.execute('mutate', {}, ctx), second.execute('mutate', {}, ctx)]);
    assert.equal(peak, 1);
});
test('tool schema validation rejects malformed input before runtime', async () => {
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const registry = new ToolRegistry();
    let ran = false;
    registry.register({ spec: { name: 'typed', description: 'Typed', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, exposure: 'direct', readOnly: true, mutates: false }, run: async () => { ran = true; return { ok: true, output: '' }; } });
    const ctx = { workspace, signal: new AbortController().signal, emit: () => { }, requestApproval: async () => 'denied' as const };
    assert.equal((await registry.execute('typed', { path: 42 }, ctx)).ok, false);
    assert.equal((await registry.execute('typed', {}, ctx)).ok, false);
    assert.equal(ran, false);
});
test('workspace file tools reject paths through external symlinks', async () => {
    const { symlinkSync } = await import('node:fs');
    const { safePath } = await import('../src/tools/builtin.js');
    const outside = mkdtempSync(join(tmpdir(), 'mad-outside-'));
    symlinkSync(outside, join(workspace, 'external'));
    assert.throws(() => safePath(workspace, 'external/new.txt'), /escapes workspace/);
});
test('saving config cannot overwrite isolated provider credentials', async () => {
    const { setKey, getStoredKey } = await import('../src/providers/manager.js');
    setKey('groq', 'test-only-key');
    saveConfig({ verifyRounds: 3 });
    assert.equal(getStoredKey('groq'), 'test-only-key');
    assert.equal(JSON.parse(readFileSync(join(process.env.MAD_HOME!, 'credentials.json'), 'utf8')).keys.groq, 'test-only-key');
});
test('session provider selection is reflected in provider listings and failed selection preserves it', async () => {
    const { setKey, listProviders } = await import('../src/providers/manager.js');
    setKey('groq', 'test-only-key');
    const session = new MadSession({ workspace, config: { ...DEFAULT_CONFIG, enabledProviders: ['opencode'] } });
    try {
        await session.selectProvider('groq', 'chosen-cloud-model');
        const selected = listProviders(session.config).find(provider => provider.name === 'groq');
        assert.equal(selected?.enabled, true);
        assert.equal(selected?.model, 'chosen-cloud-model');
        await assert.rejects(session.selectProvider('unknown-provider'), /Unknown provider|No client/);
        assert.equal(session.providerLabel(), 'groq');
        assert.equal(session.sessionModel(), 'chosen-cloud-model');
        setKey('claude', 'test-only-key');
        await session.selectProvider('claude', 'second-model');
        await session.selectProvider('groq');
        assert.equal(session.sessionModel(), 'chosen-cloud-model');
    } finally {
        await session.close();
    }
});
test('native tool execution preserves assistant calls and tool results in the next request', async () => {
    const requests: LlmRequest[] = [];
    const provider = client(req => { requests.push(structuredClone({ ...req, signal: undefined })); return requests.length === 1 ? { text: '', toolCalls: [{ id: 'native-1', name: 'read_file', args: '{"path":"fixture.txt"}' }] } : result('{"done":true,"summary":"read"}'); });
    writeFileSync(join(workspace, 'fixture.txt'), 'fixture content');
    const { BUILTIN_TOOLS } = await import('../src/tools/builtin.js');
    const outcome = await worker(provider, { tools: BUILTIN_TOOLS, maxSteps: 2 });
    assert.equal(outcome.ok, true);
    const next = requests[1].messages;
    assert.ok(next.some(m => m.toolCalls?.[0].id === 'native-1'));
    assert.ok(next.some(m => m.role === 'tool' && m.callId === 'native-1' && m.content === 'fixture content'));
});
test('MCP cancellation releases a pending request without waiting for timeout', async () => {
    const { McpConnection } = await import('../src/mcp/client.js');
    const file = join(workspace, 'mcp-cancel.cjs');
    writeFileSync(file, `const r=require('readline').createInterface({input:process.stdin});r.on('line',line=>{const q=JSON.parse(line);if(q.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{}})+'\\n');});`);
    const connection = new McpConnection('cancel', { command: process.execPath, args: [file] });
    try {
        await connection.start();
        const controller = new AbortController();
        const pending = connection.callTool('wait', {}, controller.signal);
        controller.abort();
        await assert.rejects(pending, /cancelled/);
    }
    finally {
        connection.stop();
    }
});
test('MCP spawn failure rejects initialization immediately', async () => {
    const { McpConnection } = await import('../src/mcp/client.js');
    const connection = new McpConnection('missing', { command: join(workspace, 'missing-executable') });
    try {
        await assert.rejects(connection.start(), /ENOENT/);
    }
    finally {
        connection.stop();
    }
});
test('request budgeting retains native call/result pairs and bounds history', async () => {
    const { budgetMessages } = await import('../src/tokens/budget.js');
    const messages = [{ role: 'user' as const, content: 'task' }, { role: 'assistant' as const, content: '', toolCalls: [{ id: 'bounded', name: 'read_file', args: '{"path":"a"}' }] }, { role: 'tool' as const, callId: 'bounded', name: 'read_file', content: 'x'.repeat(10000) }, { role: 'user' as const, content: 'Continue.' }];
    const bounded = budgetMessages(messages, 1500);
    assert.ok(JSON.stringify(bounded).length <= 1500);
    assert.equal(bounded[1].toolCalls?.[0].id, 'bounded');
    assert.equal(bounded[2].callId, 'bounded');
    assert.match(bounded[2].content, /truncated/);
});
test('compaction retains whole native tool transactions', async () => {
    const { ContextManager } = await import('../src/session/context.js');
    const context = new ContextManager();
    context.push({ type: 'message', role: 'user', content: 'task' });
    context.push({ type: 'assistant-message', content: '', toolRuns: [], toolCalls: [{ id: 'pair', name: 'read_file', args: '{}' }] });
    context.push({ type: 'tool-output', tool: 'read_file', callId: 'pair', output: 'result', exitCode: 0 });
    context.compact('summary', 1);
    assert.equal(context.items[1].type, 'assistant-message');
    assert.equal(context.items[2].type, 'tool-output');
});
test('greetings use zero model tokens and do not prepare repository context', async () => {
    let calls = 0;
    class Session extends MadSession {
        override async client() { calls++; throw new Error('Greeting must not call a provider'); }
    }
    const session = new Session({ workspace, config: DEFAULT_CONFIG });
    const events: string[] = [];
    const done = new Promise<void>(resolve => session.on(event => {
        events.push(event.kind);
        if (event.kind === 'turn-ended')
            resolve();
    }));
    session.submit({ kind: 'user-message', text: 'hi', workspace, mode: 'agent' });
    await done;
    assert.equal(calls, 0);
    assert.equal(session.ledger.totals().total, 0);
    assert.ok(!events.includes('dag-created'));
    assert.ok(!events.includes('agent-spawned'));
    await session.close();
});
test('normal tasks bypass the planner and fetch repository context only on demand', async () => {
    const requests: LlmRequest[] = [];
    class Session extends MadSession {
        override async client() { return client(req => { requests.push(req); return result('The answer is 42.'); }); }
    }
    const session = new Session({ workspace, config: { ...DEFAULT_CONFIG, autoCompaction: false } });
    const done = new Promise<void>(resolve => session.on(event => {
        if (event.kind === 'turn-ended')
            resolve();
    }));
    session.submit({ kind: 'user-message', text: 'Compare closures and classes', workspace, mode: 'agent' });
    await done;
    assert.equal(requests.length, 1);
    assert.ok(!requests[0].system.includes('MAD planner'));
    assert.ok(!requests[0].system.includes('Workspace tree:'));
    assert.ok(requests[0].tools?.some(tool => tool.name === 'repo_context'));
    await session.close();
});
test('full access skips approval and permits outside-workspace paths; ask mode restores both restrictions', async () => {
    const { safePath } = await import('../src/tools/builtin.js');
    const outside = join(tmpdir(), 'mad-access-check.txt');
    const session = new MadSession({ workspace, config: DEFAULT_CONFIG });
    session.setAccessMode('full');
    assert.equal(session.accessMode(), 'full');
    assert.equal(safePath(workspace, outside, session.config.fullAccess), join(realpathSync(tmpdir()), 'mad-access-check.txt'));
    assert.equal(await session.requestApproval({ tool: 'write_file', brief: outside, risk: Risk.Write }), 'approved-once');
    session.setAccessMode('ask');
    assert.throws(() => safePath(workspace, outside, session.config.fullAccess), /escapes/);
    let asked = false;
    session.on(event => {
        if (event.kind === 'approval-requested') {
            asked = true;
            session.submit({ kind: 'review', id: event.id, decision: 'denied' });
        }
    });
    assert.equal(await session.requestApproval({ tool: 'write_file', brief: outside, risk: Risk.Write }), 'denied');
    assert.equal(asked, true);
    await session.close();
});
test('large single-line tool output cannot exceed its token-control character cap', async () => {
    const { truncateOutput } = await import('../src/tokens/estimator.js');
    const output = truncateOutput('a'.repeat(100000) + 'tail', { charCap: 2000, headLines: 12, tailLines: 8 });
    assert.ok(output.text.length <= 2000);
    assert.ok(output.text.endsWith('tail'));
    assert.equal(output.truncated, true);
});
test('targeted file reads return the requested lines without injecting the whole file', async () => {
    const { BUILTIN_TOOLS } = await import('../src/tools/builtin.js');
    const tool = BUILTIN_TOOLS.find(t => t.spec.name === 'read_file')!;
    writeFileSync(join(workspace, 'ranged.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'));
    const response = await tool.run({ path: 'ranged.txt', start_line: 500, end_line: 502 }, { workspace, signal: new AbortController().signal, emit: () => { }, requestApproval: async () => 'denied' });
    assert.equal(response.ok, true);
    assert.equal(response.output, 'Lines 500-502:\nline 500\nline 501\nline 502');
});
test('the exact screenshot sequence hi, hmm, helloo and hii uses no provider or model tokens', async () => {
    let calls = 0;
    class Session extends MadSession {
        override async client() { calls++; throw new Error('No model call is needed'); }
    }
    const session = new Session({ workspace, config: DEFAULT_CONFIG });
    for (const text of ['hi', 'hmm', 'helloo', 'hii', 'HELLOOO!!!', 'hmmmm...', 'how are you?']) {
        await new Promise<void>(resolve => {
            const off = session.on(event => {
                if (event.kind === 'turn-ended') {
                    assert.equal(event.ok, true);
                    off();
                    resolve();
                }
            });
            session.submit({ kind: 'user-message', text, workspace, mode: 'agent' });
        });
    }
    assert.equal(calls, 0);
    assert.equal(session.ledger.totals().total, 0);
    await session.close();
});
test('rapid casual messages do not get queued into an expensive agent turn', async () => {
    let calls = 0;
    class Session extends MadSession {
        override async client() { calls++; throw new Error('No provider expected'); }
    }
    const session = new Session({ workspace, config: DEFAULT_CONFIG });
    const notes: string[] = [];
    const done = new Promise<void>(resolve => session.on(event => {
        if (event.kind === 'note')
            notes.push(event.text);
        if (event.kind === 'turn-ended')
            resolve();
    }));
    for (const text of ['hi', 'hmm', 'helloo', 'hii'])
        session.submit({ kind: 'user-message', text, workspace, mode: 'agent' });
    await done;
    assert.equal(calls, 0);
    assert.ok(!notes.some(text => text.includes('queued')));
    assert.equal(session.ledger.totals().total, 0);
    await session.close();
});
test('greeting variants do not absorb a real task or send earlier local chatter to the model', async () => {
    const { smallTalkReply, taskHistory } = await import('../src/session/smalltalk.js');
    for (const task of ['hii fix the tests', 'helloo, read package.json', 'hmm why is the build failing', 'yes', 'continue'])
        assert.equal(smallTalkReply(task), null);
    const items: import('../src/protocol/types.js').ResponseItem[] = [{ type: 'message', role: 'user', content: 'helloo' }, { type: 'assistant-message', content: smallTalkReply('helloo')!, toolRuns: [] }, { type: 'message', role: 'user', content: 'fix the tests' }];
    assert.deepEqual(taskHistory(items), [items[2]]);
});
test('deferred cloud tool schemas stay bounded without removing executable runtimes',async()=>{
 const {ToolRegistry}=await import('../src/tools/registry.js');const registry=new ToolRegistry();
 for(let i=0;i<9;i++)registry.register({spec:{name:`deferred_${i}`,description:`Tool ${i}`,parameters:{type:'object',properties:{}},exposure:'deferred',readOnly:true,mutates:false},run:async()=>({ok:true,output:String(i)})});
 for(let i=0;i<9;i++)registry.expose(`deferred_${i}`);
 assert.equal(registry.listDirect().length,5);assert.ok(registry.listDirect().some(tool=>tool.name==='deferred_8'));assert.ok(registry.listDeferred().some(tool=>tool.name==='deferred_0'));
 const ctx={workspace,signal:new AbortController().signal,emit:()=>{},requestApproval:async()=> 'denied' as const};
 assert.equal((await registry.execute('deferred_0',{},ctx)).output,'0');
 registry.resetDiscovery();assert.equal(registry.listDirect().length,0);assert.equal(registry.listDeferred().length,9);
});
test('cloud system prefixes stay stable when visible tool names change',async()=>{
 const {compileSystemPrompt}=await import('../src/agent/prompts.js');
 const tool=(name:string)=>({name,description:'Read',parameters:{type:'object' as const,properties:{}},exposure:'direct' as const,readOnly:true,mutates:false});
 assert.equal(compileSystemPrompt({chat:true,tools:[tool('a')]}),compileSystemPrompt({chat:true,tools:[tool('b'),tool('c')]}));
});
test('cloud defaults do not activate or fall back to optional local inference',()=>{
 assert.ok(!DEFAULT_CONFIG.enabledProviders.includes('ollama'));assert.ok(!DEFAULT_CONFIG.fallbackChain.includes('ollama'));
});
test('named workers use the shared sampling boundary for incremental human-readable output',async()=>{
 const {sampleStep}=await import('../src/agent/step.js');const deltas:string[]=[];
 const fake={name:'fixture',models:[],streaming:true,defaultModel:()=> 'fixture',hasKey:()=>true,complete:async()=>result('unused'),stream:async(_req:LlmRequest,onDelta:(text:string|null,record:unknown)=>void)=>{onDelta('{"done":true,"summary":"First',null);assert.equal(deltas.join(''),'First');onDelta('\\nSecond"}',null);return result('{"done":true,"summary":"First\\nSecond"}');}};
 const response=await sampleStep({client:fake,request:{system:'test',messages:[]},agent:'worker',streamId:'worker',emit:event=>{if(event.kind==='delta'&&event.text)deltas.push(event.text);}});
 assert.equal(deltas.join(''),'First\nSecond');assert.equal(response.usage?.estimated,true);
});
