import { Writable } from 'node:stream';

/** Translate Ink's erase-and-redraw frames into changed-line updates on a TTY. */
export class IncrementalOutput extends Writable {
    private previous: string[] | null = null;
    private readonly resize = () => { this.previous = null; this.emit('resize'); };
    constructor(private readonly terminal: NodeJS.WriteStream) {
        super();
        terminal.on('resize', this.resize);
    }
    get columns(): number { return this.terminal.columns; }
    get rows(): number { return this.terminal.rows; }
    get isTTY(): boolean { return this.terminal.isTTY; }
    override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const prefix = /^(?:(?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G)/.exec(data)?.[0];
        const frame = prefix ? data.slice(prefix.length) : data;
        if (prefix && this.previous && frame.endsWith('\n')) {
            const erased = (prefix.match(/\x1b\[2K/g) ?? []).length;
            const next = frame.slice(0, -1).split('\n');
            if (erased === this.previous.length + 1 && next.length === this.previous.length) {
                const changed: number[] = [];
                for (let i = 0; i < next.length; i++) if (next[i] !== this.previous[i]) changed.push(i);
                if (changed.length) {
                    let row = next.length;
                    let output = '';
                    for (const index of changed) {
                        const delta = row - index;
                        output += delta > 0 ? `\x1b[${delta}A` : delta < 0 ? `\x1b[${-delta}B` : '';
                        output += `\r\x1b[2K${next[index]}`;
                        row = index;
                    }
                    if (row < next.length) output += `\x1b[${next.length - row}B`;
                    this.terminal.write(output + '\r');
                }
                this.previous = next;
                callback();
                return;
            }
        }
        this.terminal.write(data);
        this.previous = frame.endsWith('\n') && !frame.includes('\x1b[2J') ? frame.slice(0, -1).split('\n') : null;
        callback();
    }
    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.terminal.off('resize', this.resize);
        callback(error);
    }
}
