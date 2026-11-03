import * as path from 'path';
const queues = new Map<string, Promise<void>>();
/** Serialize mutating tools across named agents sharing a workspace. */
export async function withWorkspaceLock<T>(workspace: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const key = path.resolve(workspace);
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    queues.set(key, tail);
    await previous;
    try {
        signal.throwIfAborted();
        return await run();
    }
    finally {
        release();
        if (queues.get(key) === tail)
            queues.delete(key);
    }
}
