import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink';
process.env.MAD_HOME = mkdtempSync(join(tmpdir(), 'mad-tui-test-'));
const { App, ActivityIndicator } = await import('../src/components/App.js');
const { Composer } = await import('../src/components/Composer.js');
const { CommandPicker } = await import('../src/components/CommandPicker.js');
const { IncrementalOutput } = await import('../src/components/incremental-output.js');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('model picker filters by typing and selects the visible model', async () => {
    const writes: string[] = [];
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); } }), { columns: 100, rows: 30, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    let selected = '';
    const picker = { kind: 'models' as const, title: 'Models', items: [
        { id: 'a', label: 'model-alpha', meta: 'provider', action: { type: 'model' as const, provider: 'groq' as const, model: 'model-alpha' } },
        { id: 'b', label: 'model-beta', meta: 'provider', action: { type: 'model' as const, provider: 'groq' as const, model: 'model-beta' } },
    ] };
    const app = render(React.createElement(CommandPicker, { picker, onSelect: item => { selected = item.id; }, onCancel: () => {} }), { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, patchConsole: false });
    try {
        await pause(80); stdin.write('beta'); await pause(80); stdin.write('\r'); await pause(80);
        assert.equal(selected, 'b');
        assert.match(writes.join(''), /Search: beta/);
    } finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});
test('typing updates changed lines without erasing the entire terminal frame', async () => {
    const writes: string[] = [];
    const terminal = Object.assign(new Writable({ write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); } }), { columns: 100, rows: 30, isTTY: true });
    const output = new IncrementalOutput(terminal as never);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const app = render(React.createElement(App), { stdout: output as never, stdin: stdin as never, stderr: terminal as never, patchConsole: false, exitOnCtrlC: false });
    try {
        await pause(150);
        writes.length = 0;
        stdin.write('a'); await pause(70);
        stdin.write('b'); await pause(70);
        stdin.write('c'); await pause(70);
        const updates = writes.join('');
        assert.match(updates, /abc/);
        assert.ok((updates.match(/\x1b\[2K/g) ?? []).length <= 6, 'each keystroke should erase only changed lines');
        assert.doesNotMatch(updates, /\x1b\[(?:2J|3J)/);
        assert.doesNotMatch(updates, /terminal agent harness/, 'unchanged header should not be redrawn');
    } finally { app.unmount(); app.cleanup(); output.destroy(); stdin.destroy(); terminal.destroy(); }
});
test('long typed input stays within a stable frame and submits the complete text', async () => {
    const writes: string[] = [];
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); } }), { columns: 80, rows: 24, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    let submitted = '';
    const app = render(React.createElement(Composer, { onSubmit: (text: string) => { submitted = text; }, busy: false, awaitingProvider: null, awaitingKey: false, provider: null, history: [], focus: true }), { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, patchConsole: false });
    try {
        await pause(60);
        const prompt = 'Make a change to the project '.repeat(8) + 'finish';
        stdin.write(prompt);
        await pause(80);
        assert.match(writes.join(''), /finish/);
        stdin.write('\r');
        await pause(80);
        assert.equal(submitted, prompt);
        assert.doesNotMatch(writes.join(''), /\x1b\[(?:2J|3J)/);
    } finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});
test('activity indicator animates while working and stops when ready', async () => {
    const writes: string[] = [];
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); } }), { columns: 80, rows: 24, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const app = render(React.createElement(ActivityIndicator, { busy: true, phase: 'Waiting for model' }), { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, patchConsole: false });
    try {
        await pause(600);
        assert.match(writes.join(''), /◐ Waiting for model/);
        assert.match(writes.join(''), /◓ Waiting for model/);
        app.rerender(React.createElement(ActivityIndicator, { busy: false, phase: 'Ready' }));
        await pause(100);
        const settled = writes.length;
        await pause(350);
        assert.equal(writes.length, settled);
        assert.doesNotMatch(writes.join(''), /\x1b\[(?:2J|3J)/);
    } finally { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); }
});
test('terminal stays idle without periodic redraws or full-screen clears', async () => {
    const writes: string[] = [];
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); } }), { columns: 80, rows: 24, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => { }, ref: () => { }, unref: () => { } });
    const app = render(React.createElement(App), { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false });
    try {
        await pause(150);
        const settled = writes.length;
        await pause(1150);
        assert.equal(writes.length, settled, 'idle screen must not redraw every second');
        assert.doesNotMatch(writes.join(''), /\x1b\[(?:2J|3J)/, 'a normal frame must not clear the entire terminal');
        stdin.write('/permissions');
        await pause(50);
        stdin.write('\r');
        await pause(80);
        assert.match(writes.join(''), /Ask permission/);
        assert.match(writes.join(''), /Full access/);
        stdin.write('\u001b[B');
        await pause(30);
        stdin.write('\r');
        await pause(60);
        assert.match(writes.join(''), /FULL ACCESS/);
        stdin.write('/permissions ask');
        await pause(30);
        stdin.write('\r');
        await pause(60);
        stdin.write('hi');
        await pause(30);
        stdin.write('\r');
        await pause(80);
        assert.match(writes.join(''), /Hi! What would you like to work on/);
        assert.doesNotMatch(writes.join(''), /\x1b\[(?:2J|3J)/, 'permission changes and greetings must not clear the full screen');
    }
    finally {
        app.unmount();
        app.cleanup();
        stdin.destroy();
        stdout.destroy();
    }
});
test('wide terminals show the agent panel and inspect agents through the command overlay',async()=>{
 const writes:string[]=[];const stdout=Object.assign(new Writable({write(chunk,_encoding,callback){writes.push(String(chunk));callback();}}),{columns:140,rows:30,isTTY:true});
 const stdin=Object.assign(new PassThrough(),{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}});
 const app=render(React.createElement(App),{stdout:stdout as never,stdin:stdin as never,stderr:stdout as never,patchConsole:false,exitOnCtrlC:false});
 const command=async(text:string)=>{stdin.write(text);await pause(30);stdin.write('\r');await pause(100);};
 try {
   await pause(150);assert.match(writes.join(''),/Agents · 0 running/);
   await command('/agent alpha coder');await command('/agents');
   assert.match(writes.join(''),/Select an agent to inspect/);assert.match(writes.join(''),/alpha/);
   stdin.write('\r');await pause(100);assert.match(writes.join(''),/Agent details/);assert.match(writes.join(''),/alpha · coder · idle/);
   stdin.write('\t');await pause(30);await command('hii');assert.match(writes.join(''),/Hi! What would you like to work on/);
   assert.doesNotMatch(writes.join(''),/\x1b\[(?:2J|3J)/);
 }finally{app.unmount();app.cleanup();stdin.destroy();stdout.destroy();}
});
