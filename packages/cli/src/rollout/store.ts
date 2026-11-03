// ─── Rollout store: list sessions, replay for resume, fork ──────────────────
import * as fs from 'fs';
import * as path from 'path';
import { sessionsRoot } from './recorder.js';
import { decodeRolloutLine, type RolloutItem, type SessionMeta } from './types.js';
import type { ResponseItem } from '../protocol/types.js';
export interface SessionSummary {
    file: string;
    id: string;
    startedAt: number;
    workspace: string;
    instruction?: string;
    provider: string;
    model: string;
    sizeBytes: number;
}
function walkDateDirs(root: string): string[] {
    const found: string[] = [];
    const visit = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
                visit(full);
            else if (entry.isFile() && entry.name.endsWith('.jsonl'))
                found.push(full);
        }
    };
    visit(root);
    return found.sort((a, b) => {
        const sa = fs.statSync(a);
        const sb = fs.statSync(b);
        return sb.mtimeMs - sa.mtimeMs;
    });
}
export function listSessions(limit = 20): SessionSummary[] {
    const root = sessionsRoot();
    if (!fs.existsSync(root))
        return [];
    const out: SessionSummary[] = [];
    for (const file of walkDateDirs(root)) {
        if (out.length >= limit)
            break;
        const meta = readSessionMeta(file);
        if (!meta)
            continue;
        out.push({
            file,
            id: meta.id,
            startedAt: meta.startedAt,
            workspace: meta.workspace ?? process.cwd(),
            instruction: meta.instruction,
            provider: meta.provider,
            model: meta.model,
            sizeBytes: fs.statSync(file).size,
        });
    }
    return out;
}
export function readSessionMeta(file: string): SessionMeta | null {
    try {
        const content = fs.readFileSync(file, 'utf8');
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            const decoded = decodeRolloutLine(line);
            if (decoded?.item === 'session-meta')
                return decoded.meta;
        }
    }
    catch {
        return null;
    }
    return null;
}
export function readRollout(file: string): RolloutItem[] {
    try {
        return fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => line.trim())
            .map(decodeRolloutLine)
            .filter((item): item is RolloutItem => Boolean(item));
    }
    catch {
        return [];
    }
}
/** Rebuild the conversation items for a resumed session. */
export function replayResponseItems(file: string): {
    items: ResponseItem[];
    meta: SessionMeta | null;
} {
    const items: ResponseItem[] = [];
    let meta: SessionMeta | null = null;
    for (const item of readRollout(file)) {
        if (item.item === 'session-meta')
            meta = item.meta;
        if (item.item === 'response')
            items.push(item.response);
        if (item.item === 'history-snapshot')
            items.splice(0, items.length, ...item.items);
        if (item.item === 'compacted') {
            items.push({ type: 'compacted', summary: item.compacted.summary, replacedItems: item.compacted.replacedItems });
        }
    }
    return { items, meta };
}
/** Reverse scan: tail N items only (fast resume head). */
export function tailResponseItems(file: string, count: number): ResponseItem[] {
    const all = readRollout(file);
    return all
        .filter((item): item is Extract<RolloutItem, {
        item: 'response';
    }> => item.item === 'response')
        .slice(-count)
        .map((item) => item.response);
}
