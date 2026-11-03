import {discoverOllama} from '../providers/ollama-native.js';
import { Command } from 'commander';
import { listProviders } from '../providers/manager.js';
import { loadConfig } from '../config/loader.js';
export const statusCommand = new Command('status').description('Show workspace and provider status').action(async () => {
    const { config, layers } = loadConfig();
    console.log(`MAD · ${process.cwd()}\nConfig: ${layers.join(', ') || 'defaults'}`);
    const providers=listProviders(config);
    const ollama=providers.find(p=>p.name==='ollama')!;
    if(config.defaultProvider==='ollama') {
        try {const discovery=await discoverOllama(config.ollamaHost||undefined,AbortSignal.timeout(1500));ollama.available=true;ollama.model=discovery.models.join(', ')||'(no installed models)';}catch{ollama.available=false;ollama.model='server unreachable';}
    } else {ollama.available=false;ollama.model='optional; not queried in cloud mode';}
    for (const p of providers)
        console.log(`${config.enabledProviders.includes(p.name) ? 'enabled' : 'disabled'} ${p.label} · ${p.model} · ${p.available ? 'available' : 'unavailable'}`);
});
