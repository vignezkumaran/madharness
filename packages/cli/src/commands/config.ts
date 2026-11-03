import { Command } from 'commander';
import { loadConfig, saveConfig } from '../config/loader.js';
import { setKey, PROVIDERS } from '../providers/manager.js';
export const configCommand = new Command('config').description('Show layered configuration or configure a provider').argument('[provider]').option('-k, --key <key>').option('--enable').option('--disable')
    .action((provider: string | undefined, options: {
    key?: string;
    enable?: boolean;
    disable?: boolean;
}) => {
    if (!provider) {
        console.log(JSON.stringify(loadConfig(), null, 2));
        return;
    }
    if (!PROVIDERS.order.includes(provider as never))
        throw new Error(`Unknown provider: ${provider}`);
    if (options.key)
        setKey(provider, options.key);
    if (options.enable || options.disable) {
        const { config } = loadConfig();
        const enabled = new Set(config.enabledProviders);
        if (options.disable)
            enabled.delete(provider);
        else
            enabled.add(provider);
        saveConfig({ enabledProviders: [...enabled] });
    }
    console.log(`Updated ${provider}.`);
});
