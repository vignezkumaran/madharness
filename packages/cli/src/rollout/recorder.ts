import * as fs from 'fs';
import * as path from 'path';
import type { RolloutItem, SessionMeta } from './types.js';
export function sessionsRoot(): string { return path.join(process.env.MAD_HOME ?? path.join(process.env.HOME ?? process.cwd(), '.mad'), 'sessions'); }
/** Append complete records synchronously; shutdown fsyncs before releasing the file. */
export class RolloutRecorder {
    private file: string | null = null;
    private fd: number | null = null;
    private closed = false;
    private readonly buffered: RolloutItem[] = [];
    async start(meta: SessionMeta): Promise<void> {
        if (this.closed)
            throw new Error('Rollout is closed');
        if (this.fd !== null)
            return;
        const date = new Date(meta.startedAt);
        const dir = path.join(sessionsRoot(), String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const filename = path.join(dir, `rollout-${meta.startedAt}-${meta.id}.jsonl`);
        this.fd = fs.openSync(filename, 'ax', 0o600);
        this.file = filename;
        this.record({ item: 'session-meta', meta });
        for (const item of this.buffered.splice(0))
            this.record(item);
    }
    get filename(): string | null { return this.file; }
    record(item: RolloutItem): void {
        if (this.closed)
            return;
        if (this.fd === null) {
            this.buffered.push(item);
            return;
        }
        fs.writeSync(this.fd, JSON.stringify(item) + '\n');
    }
    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        if (this.fd !== null) {
            const fd = this.fd;
            this.fd = null;
            try {
                fs.fsyncSync(fd);
            }
            finally {
                fs.closeSync(fd);
            }
        }
    }
}
export function eventItem(text: string): RolloutItem { return { item: 'event', event: { fine: 'note', text, at: Date.now() } }; }
