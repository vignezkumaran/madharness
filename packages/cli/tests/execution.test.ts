import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
process.env.MAD_HOME = mkdtempSync(join(tmpdir(), 'mad-execution-'));
const { MadSession } = await import('../src/session/session.js');
const { DEFAULT_CONFIG } = await import('../src/config/loader.js');
const { assistantTextStream } = await import('../src/providers/text-stream.js');
const root = mkdtempSync(join(tmpdir(), 'mad-clone-'));
const source = join(root, 'source');
const workspace = join(root, 'workspace');
mkdirSync(source);
mkdirSync(workspace);
execFileSync('git', ['init', source], { stdio: 'ignore' });
writeFileSync(join(source, 'README.md'), 'Verified clone fixture\n');
execFileSync('git', ['-C', source, 'add', 'README.md']);
execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
test('clone requests really clone and verify a repository with zero model calls', async () => {
    let calls = 0;
    class Session extends MadSession {
        override async client() { calls++; throw new Error('Clone needs no model call'); }
    }
    const session = new Session({ workspace, config: { ...DEFAULT_CONFIG, approvalPolicy: 'never' } });
    const done = new Promise<void>(resolve => session.on(event => {
        if (event.kind === 'turn-ended') {
            assert.equal(event.ok, true);
            resolve();
        }
    }));
    session.submit({ kind: 'user-message', text: `clone the repo ${pathToFileURL(source)} into copied`, workspace, mode: 'agent' });
    await done;
    assert.equal(readFileSync(join(workspace, 'copied', 'README.md'), 'utf8'), 'Verified clone fixture\n');
    assert.equal(calls, 0);
    assert.equal(session.ledger.totals().total, 0);
    await session.close();
});
test('denied cloning never creates a destination or calls a model', async () => {
    const session = new MadSession({ workspace, config: { ...DEFAULT_CONFIG, approvalPolicy: 'always' } });
    const done = new Promise<void>(resolve => session.on(event => {
        if (event.kind === 'approval-requested')
            session.submit({ kind: 'review', id: event.id, decision: 'denied' });
        if (event.kind === 'turn-ended') {
            assert.equal(event.ok, false);
            resolve();
        }
    }));
    session.submit({ kind: 'user-message', text: `clone ${pathToFileURL(source)} into denied`, workspace, mode: 'agent' });
    await done;
    assert.equal(existsSync(join(workspace, 'denied')), false);
    await session.close();
});
test('summary text streams before the JSON envelope is complete without exposing tool arguments', () => {
    const chunks: string[] = [];
    const stream = assistantTextStream(text => chunks.push(text));
    stream('{"done":true,"summary":"First line');
    assert.equal(chunks.join(''), 'First line');
    stream('\\nSecond ');
    assert.equal(chunks.join(''), 'First line\nSecond ');
    stream('line"}');
    assert.equal(chunks.join(''), 'First line\nSecond line');
    const tools: string[] = [];
    const action = assistantTextStream(text => tools.push(text));
    action('{"action":{"tool":"run_shell","args":{"command":"echo secret"}}}');
    assert.equal(tools.length, 0);
});
test('action requests cannot succeed by returning only a tutorial', async () => {
    let calls = 0;
    const fake = { name: 'fixture', models: [], streaming: true, defaultModel: () => 'fixture', hasKey: () => true, complete: async () => ({ text: 'Run this command yourself.', toolCalls: [] }), stream: async () => { calls++; return { text: 'Run this command yourself.', toolCalls: [] }; } };
    class Session extends MadSession {
        override async client() { return fake; }
    }
    const session = new Session({ workspace, config: { ...DEFAULT_CONFIG, autoCompaction: false } });
    const done = new Promise<void>(resolve => session.on(event => {
        if (event.kind === 'turn-ended') {
            assert.equal(event.ok, false);
            resolve();
        }
    }));
    session.submit({ kind: 'user-message', text: 'create a sample.txt file', workspace, mode: 'agent' });
    await done;
    assert.equal(calls, 2);
    assert.equal(existsSync(join(workspace, 'sample.txt')), false);
    await session.close();
});
test('independent conceptual questions omit all tool schemas', async () => {
    const requests: any[] = [];
    const fake = { name: 'fixture', models: [], streaming: true, defaultModel: () => 'fixture', hasKey: () => true, complete: async () => ({ text: 'A closure captures variables.', toolCalls: [] }), stream: async (req: any) => { requests.push(req); return { text: 'A closure captures variables.', toolCalls: [] }; } };
    class Session extends MadSession {
        override async client() { return fake; }
    }
    const session = new Session({ workspace, config: DEFAULT_CONFIG });
    const done = new Promise<void>(resolve => session.on(event => {
        if (event.kind === 'turn-ended')
            resolve();
    }));
    session.submit({ kind: 'user-message', text: 'Explain closures', workspace, mode: 'agent' });
    await done;
    assert.deepEqual(requests[0].tools, []);
    assert.ok(JSON.stringify({ system: requests[0].system, messages: requests[0].messages }).length < 250);
    await session.close();
});
