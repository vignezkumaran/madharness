// ─── Provider manager: registry, keyring, models, fallback chain ────────────
import {nativeOllamaClient} from './ollama-native.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Conf from 'conf';
import { loadConfig, type MadConfig } from '../config/loader.js';
import { anthropicClient, geminiClient, openAiCompatClient } from './client.js';
import type { ProviderClient } from './types.js';
import { isLocalAgentInstalled, opencodeClient, piClient } from './local-agent.js';
const execFileAsync = promisify(execFile);
type ProviderName = 'groq' | 'claude' | 'gemini' | 'codex' | 'ollama' | 'opencode' | 'pi';
interface ProviderMeta {
    keyPrefixes: string[]; // platform env var prefixes used for auto-detect
    keyEnv: string; // canonical env var
    label: string;
    isLocal?: boolean;
}
const PROVIDER_META: Record<ProviderName, ProviderMeta> = {
    groq: { keyPrefixes: ['gsk_'], keyEnv: 'GROQ_API_KEY', label: 'Groq' },
    claude: { keyPrefixes: ['sk-ant-'], keyEnv: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
    gemini: { keyPrefixes: ['AI'], keyEnv: 'GEMINI_API_KEY', label: 'Gemini' },
    codex: { keyPrefixes: ['sk-'], keyEnv: 'OPENAI_API_KEY', label: 'OpenAI (codex)' },
    ollama: { keyPrefixes: [], keyEnv: '', label: 'Ollama', isLocal: true },
    opencode: { keyPrefixes: [], keyEnv: '', label: 'OpenCode CLI', isLocal: true },
    pi: { keyPrefixes: [], keyEnv: '', label: 'Pi CLI', isLocal: true },
};
const DEFAULT_MODELS: Record<ProviderName, string> = {
    groq: 'llama-3.3-70b-versatile',
    claude: 'claude-sonnet-4-5',
    gemini: 'gemini-2.5-flash',
    codex: 'gpt-5-mini',
    ollama: 'auto (installed model)',
    opencode: 'opencode/glm-5.3-flash-free',
    pi: 'default',
};
const PROVIDER_MODEL_LISTS: Record<ProviderName, string[]> = {
    groq: [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'llama3-70b-8192',
        'qwen/qwen3-32b',
        'deepseek-r1-distill-llama-70b',
        'meta-llama/llama-4-scout-17b-16e-instruct',
        'meta-llama/llama-4-maverick-17b-128e-instruct',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'moonshotai/kimi-k2-instruct',
    ],
    claude: [
        'claude-sonnet-4-5',
        'claude-opus-4-1',
        'claude-3-7-sonnet-latest',
        'claude-3-5-haiku-latest',
    ],
    gemini: [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.5-flash-lite',
        'gemini-2.0-flash',
    ],
    codex: [
        'gpt-5-mini',
        'gpt-5',
        'gpt-4.1',
        'o4-mini',
    ],
    ollama: [],
    opencode: [],
    pi: [],
};
const PROVIDER_ORDER: ProviderName[] = ['opencode', 'pi', 'groq', 'claude', 'gemini', 'codex', 'ollama'];
interface StoreShape {
    keys: Record<string, string>;
    models: Record<string, string>;
}
const store = new Conf<StoreShape>({
    projectName: 'mad-harness',
    ...(process.env.MAD_HOME ? { cwd: process.env.MAD_HOME, configName: 'credentials' } : {}),
    defaults: { keys: {}, models: {} },
});
function readEnvKey(name: ProviderName): string | undefined {
    const meta = PROVIDER_META[name];
    if (!meta.keyEnv)
        return undefined;
    return process.env[meta.keyEnv] || undefined;
}
function storedKey(name: ProviderName): string | undefined {
    const key = (store.get('keys') as Record<string, string>)[name];
    return typeof key === 'string' && key.length > 0 ? key : readEnvKey(name);
}
function modelFor(name: ProviderName): string {
    const configured = (store.get('models') as Record<string, string>)[name];
    return typeof configured === 'string' && configured ? configured : DEFAULT_MODELS[name];
}
/** Build a live client bound to current config; throw if unusable. */
export function buildProviderClient(name: string, opts: {
    allowDisabled?: boolean;
    model?: string;
    config?: MadConfig;
} = {}): ProviderClient {
    const meta = PROVIDER_META[name as ProviderName];
    if (!meta)
        throw new Error(`Unknown provider: ${name}`);
    if (!opts.allowDisabled && !isProviderEnabled(name, opts.config)) {
        throw new Error(`Provider ${name} is disabled (enable with /config)`);
    }
    switch (name as ProviderName) {
        case 'groq':
            return openAiCompatClient({
                name,
                baseUrl: () => 'https://api.groq.com/openai/v1',
                key: () => storedKey('groq'),
                models: PROVIDER_MODEL_LISTS.groq,
                defaultModel: () => (opts.model ?? modelFor('groq')),
            });
        case 'codex':
            return openAiCompatClient({
                name,
                baseUrl: () => 'https://api.openai.com/v1',
                key: () => storedKey('codex'),
                models: PROVIDER_MODEL_LISTS.codex,
                defaultModel: () => (opts.model ?? modelFor('codex')),
            });
        case 'ollama':
            return nativeOllamaClient({host:opts.config?.ollamaHost||undefined,model:opts.model??(store.get('models') as Record<string,string>).ollama});
        case 'claude':
            return anthropicClient({
                name,
                key: () => storedKey('claude'),
                models: PROVIDER_MODEL_LISTS.claude,
                defaultModel: () => (opts.model ?? modelFor('claude')),
            });
        case 'gemini':
            return geminiClient({
                name,
                key: () => storedKey('gemini') ?? process.env.GOOGLE_API_KEY,
                models: PROVIDER_MODEL_LISTS.gemini,
                defaultModel: () => (opts.model ?? modelFor('gemini')),
            });
        case 'opencode':
            if (opts.model && !/^[^/]+\/.+/.test(opts.model))
                throw new Error('OpenCode models must use provider/model format');
            return opencodeClient(() => (opts.model ?? modelFor('opencode')), Boolean(opts.model));
        case 'pi':
            return piClient(() => (opts.model ?? modelFor('pi')));
    }
    throw new Error(`No client for ${name}`);
}
export function isProviderEnabled(name: string, config = loadConfig().config): boolean {
    return config.enabledProviders.includes(name);
}
let enabledCache: ProviderName[] | null = null;
function cachedEnabled(): ProviderName[] {
    if (!enabledCache)
        enabledCache = PROVIDER_ORDER.filter((name) => providerAvailable(name));
    return enabledCache;
}
export function providerAvailable(name: string): boolean {
    const meta = PROVIDER_META[name as ProviderName];
    if (!meta)
        return false;
    if(name==='ollama') return true; // Reachability is probed asynchronously by initialize().
    if (meta.isLocal)
        return isLocalAgentInstalled(name as 'opencode' | 'pi');
    return Boolean(storedKey(name as ProviderName));
}
export function resetEnabledCache(): void {
    enabledCache = null;
}
export const PROVIDERS = {
    order: PROVIDER_ORDER,
    meta: PROVIDER_META,
    models: PROVIDER_MODEL_LISTS,
};
export function listProviders(config: MadConfig = loadConfig().config): Array<{
    name: ProviderName;
    label: string;
    available: boolean;
    enabled: boolean;
    model: string;
    keySource: 'env' | 'config' | 'none';
}> {
    return PROVIDER_ORDER.map((name) => {
        const envKey = readEnvKey(name);
        const configKey = (store.get('keys') as Record<string, string>)[name];
        return {
            name,
            label: PROVIDER_META[name].label,
            available: providerAvailable(name),
            enabled: isProviderEnabled(name, config),
            model: name === config.defaultProvider && config.defaultModel ? config.defaultModel : modelFor(name),
            keySource: envKey ? 'env' : configKey ? 'config' : 'none',
        };
    });
}
export function providerStatusLine(): string {
    const rows = listProviders();
    return rows.map((row) => `${row.enabled ? '●' : '○'} ${row.label} (${row.model})`).join(' · ');
}
export function setKey(name: string, key: string): void {
    const keys = { ...(store.get('keys') as Record<string, string>) };
    keys[name] = key;
    store.set('keys', keys);
    resetEnabledCache();
}
export function clearKey(name: string): void {
    const keys = { ...(store.get('keys') as Record<string, string>) };
    delete keys[name];
    store.set('keys', keys);
    resetEnabledCache();
}
export function detectKey(raw: string): ProviderName | null {
    const prefixed = PROVIDER_ORDER.find((name) => PROVIDER_META[name].keyPrefixes.some((prefix) => raw.startsWith(prefix)));
    if (prefixed)
        return prefixed;
    if (raw.includes('generativelanguage') || raw.startsWith('AI') && raw.length > 30)
        return 'gemini';
    return null;
}
// ─── Fallback chain (fallback includes local agents) ────────────────────────
/** Ordered fallback chain: defaultProvider first, then every other usable provider. */
export function fallbackChain(cfg: MadConfig): ProviderName[] {
    const candidates: ProviderName[] = [];
    const push = (name: ProviderName) => {
        if (!cfg.enabledProviders.includes(name) || !providerAvailable(name) || candidates.includes(name))
            return;
        candidates.push(name);
    };
    if (cfg.defaultProvider)
        push(cfg.defaultProvider as ProviderName);
    for (const name of cfg.fallbackChain)
        push(name as ProviderName);
    return candidates;
}
// ─── Local CLI extras: list imported models ─────────────────────────────────
export async function importOpenCodeModels(): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync('opencode', ['models'], { timeout: 3000, maxBuffer: 1024 * 1024 });
        return stdout.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    }
    catch {
        return [];
    }
}
export type { ProviderName };
export { modelFor as getModelFor, storedKey as getStoredKey };
