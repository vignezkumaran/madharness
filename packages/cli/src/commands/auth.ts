import {discoverOllama} from '../providers/ollama-native.js';
import { Command } from 'commander';
import * as readline from 'readline/promises';
import { setKey, detectKey, PROVIDERS } from '../providers/manager.js';
export const authCommand = new Command('auth').description('Connect a provider using an API key').argument('[provider]').option('-k, --key <key>')
    .action(async (provider: string | undefined, options: {
    key?: string;
}) => {
    if(provider==='ollama') {const discovery=await discoverOllama();console.log(`Ollama connected: ${discovery.base}\nModels: ${discovery.models.join(', ')||'(none installed)'}`);return;}
    let key = options.key ?? '';
    if (!key && process.stdin.isTTY) {
        const { promptHidden } = await import('../utils/prompt.js');
        key = await promptHidden('API key: ');
    }
    const name = provider ?? detectKey(key);
    if (!key.trim() || !name || !PROVIDERS.order.includes(name as never)) {
        console.error('Provide a supported provider and API key.');
        process.exitCode = 1;
        return;
    }
    setKey(name, key.trim());
    console.log(`Connected ${name}.`);
});
