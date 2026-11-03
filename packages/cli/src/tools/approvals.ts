// ─── Approval gate: policy × risk, rules persisted to ~/.mad/permissions.json
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ApprovalPolicy, ReviewDecision } from '../protocol/types.js';
import { Risk } from '../protocol/types.js';
import type { ApprovalRequestBrief } from './types.js';
export function permissionsFile(): string {
    return path.join(process.env.MAD_HOME ?? path.join(os.homedir(), '.mad'), 'permissions.json');
}
/** Rule keys: write:path | shell:<exact command> | shell-prefix:<prefix> */
export interface PersistedRule {
    key: string;
    grantedAt: number;
    scope: 'session' | 'global';
}
export class ApprovalStore {
    private rules = new Map<string, PersistedRule>();
    private dirty = false;
    load(): void {
        try {
            if (!fs.existsSync(permissionsFile()))
                return;
            const parsed = JSON.parse(fs.readFileSync(permissionsFile(), 'utf8')) as PersistedRule[];
            if (Array.isArray(parsed)) {
                this.rules = new Map(parsed.map((rule) => [rule.key, rule]));
            }
        }
        catch {
            this.rules = new Map();
        }
    }
    private save(): void {
        if (!this.dirty)
            return;
        try {
            fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
            fs.writeFileSync(permissionsFile(), JSON.stringify(Array.from(this.rules.values()), null, 2) + '\n');
            this.dirty = false;
        }
        catch {
            // permissions that fail to persist stay session-only; never crash a turn
        }
    }
    has(key: string): PersistedRule | null {
        return this.rules.get(key) ?? null;
    }
    grant(key: string, scope: 'session' | 'global'): void {
        this.rules.set(key, { key, grantedAt: Date.now(), scope });
        if (scope === 'global')
            this.dirty = true;
        this.save();
    }
    revoke(key: string): boolean {
        const removed = this.rules.delete(key);
        this.dirty = true;
        this.save();
        return removed;
    }
    keys(): PersistedRule[] {
        return Array.from(this.rules.values());
    }
    clear(): number {
        const count = this.rules.size;
        this.rules.clear();
        this.dirty = true;
        this.save();
        return count;
    }
}
/** Rule lookup with exact then prefix matching for shell commands. */
export function matchingRule(store: ApprovalStore, request: ApprovalRequestBrief): PersistedRule | null {
    const key = ruleKey(request);
    const exact = store.has(key);
    if (exact)
        return exact;
    if (request.risk === Risk.Shell || request.risk === Risk.ShellDestructive) {
        const words = String(request.brief).split(/\s+/);
        for (let take = words.length; take >= 2; take--) {
            const prefix = store.has(`shell-prefix:${words.slice(0, take).join(' ')}`);
            if (prefix)
                return prefix;
        }
    }
    return null;
}
export function ruleKey(request: ApprovalRequestBrief): string {
    switch (request.risk) {
        case Risk.Read:
            return 'read';
        case Risk.Write:
            return `write:${request.tool}:${request.brief}`;
        case Risk.Shell:
        case Risk.ShellDestructive:
            return `shell:${request.brief}`;
    }
}
export type ApprovalRequirement = {
    requirement: 'skip';
} | {
    requirement: 'review';
    reason: string;
} | {
    requirement: 'forbidden';
    reason: string;
};
export function computeRequirement(request: ApprovalRequestBrief, policy: ApprovalPolicy, store: ApprovalStore): ApprovalRequirement {
    if (request.risk === Risk.Read)
        return { requirement: 'skip' };
    if (policy === 'always')
        return { requirement: 'review', reason: 'Ask permission mode' };
    const rule = matchingRule(store, request);
    if (rule)
        return { requirement: 'skip' };
    if (policy === 'never')
        return { requirement: 'skip' };
    return { requirement: 'review', reason: `${request.risk} requires approval (policy: ${policy})` };
}
const DESTRUCTIVE_PATTERN = /\b(rm\s+-[rf]|rm\s+--|git\s+reset\s+--hard|git\s+push\s+--force|git\s+clean\s+-[fdx]|sudo\s|chmod\s+-R\s+777|dd\s+if=|mkfs|shutdown|reboot|>\s*\/dev\/)/;
export function classifyRisk(tool: string, args: Record<string, unknown>): {
    tool: string;
    risk: Risk;
    brief: string;
} {
    const resolvePath = (value: unknown) => path.resolve(String(value ?? ''));
    switch (tool) {
        case 'write_file':
        case 'edit_file':
            return { tool, risk: Risk.Write, brief: resolvePath(args.path) };
        case 'run_shell': {
            const raw = String(args.command ?? '');
            const cmd = raw.trim();
            const brief = cmd;
            return { tool, risk: DESTRUCTIVE_PATTERN.test(cmd) ? Risk.ShellDestructive : Risk.Shell, brief };
        }
        case 'delete':
            return { tool, risk: Risk.ShellDestructive, brief: String(args.path ?? '') };
        default:
            return { tool, risk: Risk.Read, brief: tool };
    }
}
