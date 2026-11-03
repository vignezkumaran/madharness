import { Command } from 'commander';
import { MadSession } from '../session/session.js';
import { loadConfig } from '../config/loader.js';
export const askCommand = new Command('ask').description('Ask a provider directly without tools').argument('<prompt...>').option('-m, --model <provider>')
    .action(async (parts: string[], options: {
    model?: string;
}) => {
    const session = new MadSession({ workspace: process.cwd(), config: loadConfig().config, provider: options.model });
    try {
        const client = await session.client();
        let streamed = '';
        const result = await client.stream({ workspace: process.cwd(), system: 'You are MAD. Answer concisely.', messages: [{ role: 'user', content: parts.join(' ') }] }, text => {
            if (text) {
                process.stdout.write(text);
                streamed += text;
            }
        });
        if (result.text.startsWith(streamed))
            process.stdout.write(result.text.slice(streamed.length) + '\n');
        else
            console.log(result.text);
    }
    catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
    }
    finally {
        await session.close();
    }
});
