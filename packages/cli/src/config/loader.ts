// ─── Layered config (~/.mad/config.json -> project .mad/config.json -> CLI) ─
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ApprovalPolicy } from '../protocol/types.js';
export interface MadConfig {
    defaultProvider: string;
    defaultModel: string;
    ollamaHost:string;
    fallbackChain: string[];
    approvalPolicy: ApprovalPolicy;
    enabledProviders: string[];
    mcpServers: Record<string, {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        enabled?: boolean;
    }>;
    maxStepsPerTask: number;
    agentTaskTokenBudget: number;
    verifyRounds: number;
    contextCharBudget: number;
    toolOutputCharCap: number;
    autoCompaction: boolean;
    fullAccess: boolean;
    agents: Record<string, {
        role: string;
        model?: string;
        task?: string;
    }>;
}
const USER_CONFIG = () => path.join(process.env.MAD_HOME ?? path.join(os.homedir(), '.mad'), 'config.json');
const PROJECT_CONFIG = (workspace = process.cwd()) => path.join(workspace, '.mad', 'config.json');
export const DEFAULT_CONFIG: MadConfig = {
    defaultProvider: 'opencode',
    defaultModel: '',
    ollamaHost:'',
    fallbackChain: ['opencode', 'pi', 'groq', 'claude', 'gemini', 'codex'],
    approvalPolicy: 'on-request',
    enabledProviders: ['opencode', 'pi'],
    mcpServers: {},
    maxStepsPerTask: 14,
    agentTaskTokenBudget: 30000,
    verifyRounds: 2,
    contextCharBudget: 12000,
    toolOutputCharCap: 8000,
    autoCompaction: true,
    fullAccess: false,
    agents: {},
};
function readLayer(file: string): Partial<MadConfig> {
    if (!fs.existsSync(file))
        return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        throw new Error(`Cannot parse configuration: ${file}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`Expected a configuration object: ${file}`);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_CONFIG))
        if (key in parsed)
            out[key] = (parsed as Record<string, unknown>)[key];
    return out as Partial<MadConfig>;
}
export function configOrigin(file: string): string {
    return file.replace(os.homedir(), '~');
}
export function loadConfig(cliOverrides: Partial<MadConfig> = {}, workspace = process.cwd()): {
    config: MadConfig;
    layers: string[];
} {
    const layers = [USER_CONFIG(), PROJECT_CONFIG(workspace)];
    const merged = structuredClone(DEFAULT_CONFIG);
    const applied: string[] = [];
    for (const file of layers) {
        if (!fs.existsSync(file))
            continue;
        applied.push(configOrigin(file));
        const layer = readLayer(file);
        Object.assign(merged, { ...layer, mcpServers: { ...merged.mcpServers, ...layer.mcpServers }, agents: { ...merged.agents, ...layer.agents } });
    }
    // CLI overrides always win; never allow empty nullable strings
    const overrides = Object.fromEntries(Object.entries(cliOverrides).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    Object.assign(merged, overrides);
    for (const key of ['maxStepsPerTask', 'agentTaskTokenBudget', 'contextCharBudget', 'toolOutputCharCap'] as const) {
        if (!Number.isInteger(merged[key]) || merged[key] < 1)
            throw new Error(`Invalid config: ${key} must be a positive integer`);
    }
    if (!Number.isInteger(merged.verifyRounds) || merged.verifyRounds < 0)
        throw new Error('Invalid config: verifyRounds must be a nonnegative integer');
    if (!['never', 'on-request', 'always'].includes(merged.approvalPolicy))
        throw new Error('Invalid approval policy');
    for (const key of ['enabledProviders', 'fallbackChain'] as const)
        if (!Array.isArray(merged[key]) || !merged[key].every(value => typeof value === 'string'))
            throw new Error(`Invalid config: ${key} must be a string array`);
    if (typeof merged.defaultProvider !== 'string' || typeof merged.defaultModel !== 'string' || typeof merged.autoCompaction !== 'boolean' || typeof merged.fullAccess !== 'boolean')
        throw new Error('Invalid provider, model or autoCompaction configuration');
    if (!merged.mcpServers || typeof merged.mcpServers !== 'object' || Array.isArray(merged.mcpServers))
        throw new Error('Invalid mcpServers config');
    for (const [name, server] of Object.entries(merged.mcpServers)) {
        if (!server || typeof server.command !== 'string' || !server.command.trim() || (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(arg => typeof arg === 'string'))) || (server.env !== undefined && (!server.env || typeof server.env !== 'object' || !Object.values(server.env).every(value => typeof value === 'string'))))
            throw new Error(`Invalid MCP server configuration: ${name}`);
    }
    return { config: merged as MadConfig, layers: applied };
}
export function saveConfig(partial: Partial<MadConfig>, scope: 'user' | 'project' = 'user'): MadConfig {
    const file = scope === 'user' ? USER_CONFIG() : PROJECT_CONFIG();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = readLayer(file);
    const updated = { ...existing, ...partial };
    loadConfig(updated);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
    const { config } = loadConfig();
    return config;
}
export function hasShowableConfig(): boolean {
    return fs.existsSync(USER_CONFIG()) || fs.existsSync(PROJECT_CONFIG());
}
