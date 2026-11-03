import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const entry = resolve('packages/cli/src/index.ts');
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'mad-cli-'));
    const bin = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    mkdirSync(bin);
    mkdirSync(workspace);
    mkdirSync(home);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ defaultProvider: 'opencode', enabledProviders: ['opencode'], fallbackChain: [], maxStepsPerTask: 4, verifyRounds: 0, autoCompaction: false }));
    writeFileSync(join(bin, 'opencode'), `#!${process.execPath}
const fs=require('fs');
const input=process.argv.at(-1)||'';
let answer;
if(input.includes('MAD planner')) answer={answer:null,tasks:[{id:'code',title:'Create result.txt',detail:'Write hello fixture into result.txt',role:'coder',dependsOn:[]},{id:'verify',title:'Verify result.txt',role:'verifier',dependsOn:['code']}]};
else if(input.includes('Verify:')) answer={pass:true,issues:[]};
else if(input.includes('tool write_file: wrote')) answer={done:true,summary:'Created fixture file'};
else answer={action:{tool:'write_file',args:{path:'result.txt',content:'hello fixture'}}};
process.stdout.write(JSON.stringify({type:'text',part:{type:'text',text:JSON.stringify(answer)}})+'\\n');
`, { mode: 0o755 });
    return { root, home, workspace, env: { ...process.env, MAD_HOME: home, MAD_OPENCODE_TRANSPORT: 'run', PATH: bin + ':' + process.env.PATH, NO_COLOR: '1' } };
}
test('real CLI entry executes directly without a planner and persists a rollout', async () => {
    const f = fixture();
    const response = await exec(process.execPath, ['--import', 'tsx', entry, 'agent', 'create the fixture', '--cwd', f.workspace, '--yes'], { env: f.env, timeout: 20000 });
    assert.match(response.stdout, /Created fixture file/);
    assert.doesNotMatch(response.stdout, /DAG complete|Plan ready/);
    assert.equal(readFileSync(join(f.workspace, 'result.txt'), 'utf8'), 'hello fixture');
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(join(dir, item.name)) : [join(dir, item.name)]);
    const files = walk(join(f.home, 'sessions'));
    assert.equal(files.length, 1);
    assert.match(readFileSync(files[0], 'utf8'), /Created fixture file/);
});
test('noninteractive CLI denies writes without --yes and exits incomplete', async () => {
    const f = fixture();
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', entry, 'agent', 'create the fixture', '--cwd', f.workspace], { env: f.env, timeout: 20000 }), error => {
        assert.equal((error as {
            code: number;
        }).code, 1);
        return true;
    });
});
test('status and help work with isolated configuration in an ES module process', async () => {
    const f = fixture();
    const status = await exec(process.execPath, ['--import', 'tsx', entry, 'status'], { env: f.env, timeout: 10000 });
    assert.match(status.stdout, /OpenCode CLI/);
    const help = await exec(process.execPath, ['--import', 'tsx', entry, '--help'], { env: f.env, timeout: 10000 });
    assert.match(help.stdout, /Named agents/);
});
test('an explicit invalid provider fails without silently selecting another provider', async () => {
    const f = fixture();
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', entry, 'agent', 'task', '--provider', 'invalid-provider', '--cwd', f.workspace], { env: f.env, timeout: 10000 }), error => {
        assert.match(String((error as {
            stderr: string;
        }).stderr), /Unknown provider: invalid-provider/);
        return true;
    });
});
test('explicit --plan produces a plan without executing its tools', async () => {
    const f = fixture();
    const response = await exec(process.execPath, ['--import', 'tsx', entry, 'agent', 'create the fixture', '--cwd', f.workspace, '--plan'], { env: f.env, timeout: 10000 });
    assert.match(response.stdout, /Plan ready/);
    assert.ok(!readdirSync(f.workspace).includes('result.txt'));
});
test('a plain hi works without a provider call or tool schema payload', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'bin', 'opencode'), `#!${process.execPath}\nprocess.exit(99);\n`, { mode: 0o755 });
    for (const text of ['hi', 'hmm', 'helloo', 'hii']) {
        const response = await exec(process.execPath, ['--import', 'tsx', entry, text, '--cwd', f.workspace], { env: f.env, timeout: 10000 });
        assert.match(response.stdout, /Hi! What would you like to work on|Take your time/);
    }
});
test('OpenCode total tokens are not counted again as output tokens', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'bin', 'opencode'), `#!${process.execPath}\nconsole.log(JSON.stringify({type:'text',part:{type:'text',text:'done'}}));console.log(JSON.stringify({type:'step_finish',part:{tokens:{input:100,output:5,total:105}}}));\n`, { mode: 0o755 });
    const localModule = resolve('packages/cli/src/providers/local-agent.ts');
    const script = `import {opencodeClient} from ${JSON.stringify(localModule)};const result=await opencodeClient(()=> 'fixture').complete({system:'instructions',messages:[{role:'user',content:'test'}]});console.log(JSON.stringify(result.usage));`;
    const response = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: f.env, timeout: 10000 });
    assert.deepEqual(JSON.parse(response.stdout.trim()), { input: 100, output: 5 });
});
test('CLI writes the first streamed line before the provider finishes, without duplicating the final answer', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'bin', 'opencode'), `#!${process.execPath}
console.log(JSON.stringify({type:'text',part:{type:'text',text:'First streamed line\\n'}}));
setTimeout(()=>console.log(JSON.stringify({type:'text',part:{type:'text',text:'Second streamed line'}})),150);
`, { mode: 0o755 });
    const child = spawn(process.execPath, ['--import', 'tsx', entry, 'Explain streaming', '--cwd', f.workspace], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let first = 0;
    let second = 0;
    let errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); if (!first && output.includes('First streamed line'))
        first = Date.now(); if (!second && output.includes('Second streamed line'))
        second = Date.now(); });
    child.stderr.on('data', chunk => errors += String(chunk));
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, errors);
    assert.ok(first > 0);
    assert.ok(second - first >= 70, 'first line must arrive before the second line is produced');
    assert.equal(output, 'First streamed line\nSecond streamed line\n');
});
test('portable launchers select the updated workspace build rather than stale bundled code',async()=>{
 const f=fixture();
 for(const folder of ['mad-harness-0.3.0','mad-harness-0.3.0 2']) {
   const response=await exec('sh',[resolve(folder,'mad'),'agent','--help'],{env:f.env,timeout:10000});
   assert.match(response.stdout,/--plan/);assert.match(response.stdout,/--full-access/);
 }
});
