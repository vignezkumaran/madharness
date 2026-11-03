// ─── Shared HTTP plumbing: timeout, SSE reader, retry ───────────────────────
import { setTimeout as delay } from 'node:timers/promises';
import type { LlmRequest } from './types.js';
export async function readErrorBody(response: Response): Promise<string> {
    try {
        return (await response.text()).slice(0, 2000);
    }
    catch {
        return '(unavailable)';
    }
}
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
}
export function backoffMs(attempt: number): number {
    return Math.min(8000, 400 * 2 ** attempt) + Math.random() * 250;
}
interface RetryableError extends Error {
    status?: number;
}
export interface RunWithRetryOptions<T> {
    attempts?: number;
    label: string;
    signal?: AbortSignal;
    run: (attempt: number) => Promise<T>;
}
export async function runWithRetry<T>({ attempts = 3, label, signal, run }: RunWithRetryOptions<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
        if (signal?.aborted)
            break;
        try {
            return await run(attempt);
        }
        catch (error) {
            lastError = error;
            const status = (error as RetryableError)?.status;
            if (signal?.aborted || status === undefined || !isRetryableStatus(status) || attempt === attempts - 1)
                break;
            await delay(backoffMs(attempt), undefined, { signal });
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`${label} failed: ${String(lastError)}`);
}
/**
 * Read an SSE body, yielding complete `data:` payloads.
 * Handles multi-line frames and `data: [DONE]` markers.
 */
export async function* sseData(response: Response): AsyncGenerator<string> {
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error('Response body is not readable');
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let end = buffer.indexOf('\n');
            while (end !== -1) {
                const line = buffer.slice(0, end).replace(/\r$/, '');
                buffer = buffer.slice(end + 1);
                if (line === '') {
                    if (data.length) {
                        yield data.join('\n');
                        data = [];
                    }
                }
                else if (line.startsWith('data:'))
                    data.push(line.slice(5).replace(/^ /, ''));
                end = buffer.indexOf('\n');
            }
            if (done)
                break;
        }
        if (buffer.startsWith('data:'))
            data.push(buffer.slice(5).replace(/^ /, ''));
        if (data.length)
            yield data.join('\n');
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
export interface PreparedRequest {
    url: string;
    body: string;
    headers: Record<string, string>;
    signal: AbortSignal;
}
/** Standard POST prep: streaming keeps caller's signal, non-streaming gets a deadline. */
export function preparePost(req: LlmRequest, args: {
    url: string;
    payload: unknown;
    headers: Record<string, string>;
    timeoutMs?: number;
}): PreparedRequest {
    const useSignal = withTimeout(req.signal, args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 180000);
    return {
        url: args.url,
        body: JSON.stringify(args.payload),
        headers: { 'content-type': 'application/json', ...args.headers },
        signal: useSignal,
    };
}
/** Normalize an HTTP failure into a retryable Error carrying the status. */
export async function httpFailure(provider: string, response: Response): Promise<Error> {
    const body = await readErrorBody(response);
    return Object.assign(new Error(`${provider} HTTP ${response.status}: ${body}`), { status: response.status });
}
