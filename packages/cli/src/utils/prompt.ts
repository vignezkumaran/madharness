export function promptHidden(question: string): Promise<string> {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        process.stdout.write(question);
        if (!stdin.isTTY) {
            let value = '';
            stdin.setEncoding('utf8');
            stdin.resume();
            stdin.on('data', (chunk) => {
                value += chunk;
            });
            stdin.on('end', () => resolve(value.trim()));
            return;
        }
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let value = '';
        const cleanup = () => {
            stdin.setRawMode(wasRaw ?? false);
            stdin.pause();
            stdin.off('data', onData);
        };
        const onData = (char: string) => {
            if (char === '\r' || char === '\n') {
                cleanup();
                process.stdout.write('\n');
                resolve(value.trim());
                return;
            }
            if (char === '\u0003') {
                cleanup();
                process.stdout.write('\n');
                process.exit(130);
            }
            if (char === '\u007f' || char === '\b') {
                if (value.length > 0) {
                    value = value.slice(0, -1);
                    process.stdout.write('\b \b');
                }
                return;
            }
            value += char;
            process.stdout.write('*');
        };
        stdin.on('data', onData);
    });
}
