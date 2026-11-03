import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Risk } from '../protocol/types.js';
import type { Tool } from './types.js';
const exec = promisify(execFile);
export interface CloneRequest {
    url: string;
    destination?: string;
}
/** Only standalone clone commands take the deterministic path; compound tasks go to the agent. */
export function cloneRequest(text: string): CloneRequest | null {
    const match = /^(?:please\s+)?(?:git\s+)?clone\s+(?:(?:the|this)\s+)?(?:(?:repo|repository)\s+)?(?:(?:from|at)\s+)?(https?:\/\/\S+|file:\/\/\S+|git@\S+)(?:\s+(?:into|to|in)\s+("[^"]+"|'[^']+'|\S+))?\s*$/i.exec(text.trim());
    if (!match)
        return null;
    return { url: match[1], destination: match[2]?.replace(/^['"]|['"]$/g, '') };
}
export function cloneTool(resolve: (workspace: string, target: unknown, fullAccess?: boolean) => string): Tool {
    return {
        spec: { name: 'git_clone', description: 'Clone a Git repository and verify the resulting working tree.', parameters: { type: 'object', properties: { url: { type: 'string' }, destination: { type: 'string' } }, required: ['url'] }, exposure: 'direct', readOnly: false, mutates: true },
        run: async (args, ctx) => {
            const url = String(args.url);
            if (url.startsWith('-') || /[\r\n\0]/.test(url))
                return { ok: false, output: 'Invalid repository URL' };
            const defaultName = url.replace(/\/$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '');
            const destination = resolve(ctx.workspace, args.destination ?? defaultName, ctx.fullAccess);
            if (!defaultName && !args.destination)
                return { ok: false, output: 'Specify a destination directory' };
            if (fs.existsSync(destination))
                return { ok: false, output: `Destination already exists: ${destination}` };
            const decision = await ctx.requestApproval({ tool: 'git_clone', risk: Risk.Shell, brief: `git clone -- ${JSON.stringify(url)} ${JSON.stringify(destination)}` });
            if (decision === 'denied')
                return { ok: false, denied: true, output: 'Repository clone denied by user.' };
            ctx.signal.throwIfAborted();
            // Revalidate the path after awaiting user approval.
            resolve(ctx.workspace, destination, ctx.fullAccess);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            await exec('git', ['clone', '--', url, destination], { cwd: ctx.workspace, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, signal: ctx.signal, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
            const check = await exec('git', ['-C', destination, 'rev-parse', '--is-inside-work-tree'], { cwd: ctx.workspace, signal: ctx.signal, timeout: 10000 });
            if (check.stdout.trim() !== 'true')
                return { ok: false, output: 'Git returned without a verified working tree' };
            return { ok: true, output: `Cloned ${url} into ${destination}. Verified Git working tree.` };
        }
    };
}
