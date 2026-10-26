import Conf from 'conf';
import { execFile, spawnSync } from 'child_process';
import type { ProviderName, ProviderConfig, ProviderState, ProviderStatus } from '../types.js';

// ─── Default Provider Configurations ────────────────────────────────────────

const DEFAULT_CONFIGS: Record<ProviderName, ProviderConfig> = {
  groq: {
    name: 'groq',
    displayName: 'Groq GPT-OSS 120B',
    model: 'openai/gpt-oss-120b',
    isAvailable: true,
    maxTokens: 32768,
  },
  claude: {
    name: 'claude',
    displayName: 'Claude 3.5 Sonnet',
    model: 'claude-3-5-sonnet-20241022',
    isAvailable: true,
    maxTokens: 100000,
  },
  codex: {
    name: 'codex',
    displayName: 'GPT-4o (OpenAI)',
    model: 'gpt-4o',
    isAvailable: true,
    maxTokens: 128000,
  },
  gemini: {
    name: 'gemini',
    displayName: 'Gemini 2.0 Flash',
    model: 'gemini-2.0-flash',
    isAvailable: true,
    maxTokens: 128000,
  },
  ollama: {
    name: 'ollama',
    displayName: 'Ollama (Local)',
    model: 'llama3',
    baseUrl: 'http://localhost:11434',
    isAvailable: true,
    maxTokens: 4096,
  },
  opencode: {
    name: 'opencode',
    displayName: 'OpenCode (local agent)',
    model: 'opencode/deepseek-v4.1-flash-free',
    isAvailable: true,
    maxTokens: 32768,
  },
  pi: {
    name: 'pi',
    displayName: 'Pi (local agent)',
    model: 'default',
    isAvailable: true,
    maxTokens: 32768,
  },
};

// Curated model IDs per provider. The configured model is always included too.
export const PROVIDER_MODELS: Record<ProviderName, string[]> = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  claude: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
  codex: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  gemini: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'],
  ollama: ['llama3', 'qwen2.5-coder', 'deepseek-coder-v2'],
  opencode: ['opencode/deepseek-v4.1-flash-free', 'opencode/big-pickle'],
  pi: ['default'],
};

// ─── Provider Fabric (multi-provider router) ────────────────────────────────
// Lightning-style harnesses lock to one fast model. MAD Fabric instead:
//   - fan-out: one prompt → many providers at once (compare/consensus)
//   - fallback: if primary fails/rate-limits, auto-route to next live key
//   - cost-aware: prefer cheapest connected model for distill-friendly tasks
// ─────────────────────────────────────────────────────────────────────────────

export type FabricStrategy = 'fallback' | 'fanout' | 'cheapest';

const LOCAL_AGENTS: ProviderName[] = ['opencode', 'pi'];
const DEFAULT_DISABLED_PROVIDERS: ProviderName[] = ['groq', 'pi'];
const DEFAULT_PROVIDER: ProviderName = 'opencode';

export class ProviderManager {
  private config: Conf<Record<string, unknown>>;
  private providers: Map<ProviderName, ProviderState>;
  private fallbackOrder: ProviderName[] = ['groq', 'claude', 'gemini', 'codex', 'ollama'];
  private disabledProviders: Set<ProviderName>;
  private binaryCache = new Map<ProviderName, boolean>();
  private localModelCache = new Map<ProviderName, string[]>();
  private localModelPromises = new Map<ProviderName, Promise<string[]>>();

  constructor() {
    this.config = new Conf({ projectName: 'mad-harness' });
    this.providers = new Map();
    const stored = this.config.get('disabledProviders') as string[] | undefined;
    const disabled = Array.isArray(stored) ? stored : DEFAULT_DISABLED_PROVIDERS;
    this.disabledProviders = new Set(
      disabled.filter((name): name is ProviderName => typeof name === 'string' && name in DEFAULT_CONFIGS)
    );
    this.initializeProviders();
  }

  isProviderDisabled(name: ProviderName): boolean {
    return this.disabledProviders.has(name);
  }

  getVisibleProviders(): Map<ProviderName, ProviderState> {
    return new Map(
      Array.from(this.providers.entries()).filter(([name]) => !this.isProviderDisabled(name))
    );
  }

  setProviderDisabled(name: ProviderName, disabled: boolean): void {
    if (disabled) this.disabledProviders.add(name);
    else this.disabledProviders.delete(name);
    this.config.set('disabledProviders', Array.from(this.disabledProviders));
  }

  public resolveProviderName(raw: string): ProviderName | null {
    const clean = raw.trim().toLowerCase();
    if (clean === 'groq' || clean === 'grok') return 'groq';
    if (clean === 'claude' || clean === 'anthropic') return 'claude';
    if (clean === 'codex' || clean === 'openai' || clean === 'gpt' || clean === 'gpt4' || clean === 'gpt-4o') return 'codex';
    if (clean === 'gemini' || clean === 'google') return 'gemini';
    if (clean === 'ollama' || clean === 'local') return 'ollama';
    if (clean === 'opencode' || clean === 'open-code') return 'opencode';
    if (clean === 'pi') return 'pi';
    return null;
  }

  private isLocalAgent(name: ProviderName): boolean {
    return LOCAL_AGENTS.includes(name);
  }

  private parseOpencodeModels(stdout: string): string[] {
    const clean = stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    return clean
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.includes(' ') && line.includes('/'));
  }

  private parsePiModels(stdout: string): string[] {
    const clean = stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    return clean
      .split('\n')
      .slice(1)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() && !/^[-\s]+$/.test(line))
      .map((line) => {
        const columns = line.trim().split(/\s{2,}/);
        const provider = columns[0]?.trim();
        const model = columns[1]?.trim();
        if (!provider || !model) return '';
        return `${provider}/${model}`;
      })
      .filter(Boolean);
  }

  private extractLocalModels(name: ProviderName): Promise<string[]> {
    const cached = this.localModelCache.get(name);
    if (cached) return Promise.resolve(cached);
    const inflight = this.localModelPromises.get(name);
    if (inflight) return inflight;
    if (!this.isLocalAgent(name) || !this.binaryAvailable(name)) {
      this.localModelCache.set(name, []);
      return Promise.resolve([]);
    }

    const command = name === 'opencode' ? 'opencode' : 'pi';
    const args = name === 'opencode' ? ['models'] : ['--list-models'];
    const promise = new Promise<string[]>((resolve) => {
      execFile(
        command,
        args,
        {
          encoding: 'utf8',
          timeout: 20_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        },
        (error, stdout) => {
          const models = !error && stdout
            ? name === 'opencode'
              ? this.parseOpencodeModels(stdout)
              : this.parsePiModels(stdout)
            : [];
          const unique = [...new Set(models)];
          this.localModelCache.set(name, unique);
          resolve(unique);
        }
      );
    });

    this.localModelPromises.set(name, promise);
    void promise.then(() => this.localModelPromises.delete(name));
    return promise;
  }

  /** Import the model catalog from each detected local CLI. */
  async warmLocalModels(): Promise<void> {
    await Promise.all(
      LOCAL_AGENTS
        .filter((name) => !this.isProviderDisabled(name) && this.binaryAvailable(name))
        .map((name) => this.extractLocalModels(name))
    );
  }

  private binaryAvailable(name: ProviderName): boolean {
    const cached = this.binaryCache.get(name);
    if (cached !== undefined) return cached;
    try {
      const command = process.platform === 'win32' ? 'where' : 'which';
      const result = spawnSync(command, [name], { stdio: 'ignore' });
      const available = result.status === 0;
      this.binaryCache.set(name, available);
      return available;
    } catch {
      this.binaryCache.set(name, false);
      return false;
    }
  }

  private syncToEnv(name: ProviderName, key?: string): void {
    if (!key) return;
    if (name === 'claude') process.env.ANTHROPIC_API_KEY = key;
    else if (name === 'groq') process.env.GROQ_API_KEY = key;
    else if (name === 'codex') process.env.OPENAI_API_KEY = key;
    else if (name === 'gemini') {
      process.env.GEMINI_API_KEY = key;
      process.env.GOOGLE_API_KEY = key;
    }
  }

  private clearFromEnv(name: ProviderName): void {
    if (name === 'claude') delete process.env.ANTHROPIC_API_KEY;
    else if (name === 'groq') delete process.env.GROQ_API_KEY;
    else if (name === 'codex') delete process.env.OPENAI_API_KEY;
    else if (name === 'gemini') {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
    }
  }

  private initializeProviders(): void {
    for (const [name, config] of Object.entries(DEFAULT_CONFIGS)) {
      const pName = name as ProviderName;
      const savedModel = this.config.get(`models.${pName}`) as string | undefined;
      let savedKey = this.config.get(`apiKeys.${pName}`) as string | undefined;

      // Check process.env if not in saved config
      if (!savedKey) {
        if (pName === 'claude') savedKey = process.env.ANTHROPIC_API_KEY;
        else if (pName === 'groq') savedKey = process.env.GROQ_API_KEY;
        else if (pName === 'codex') savedKey = process.env.OPENAI_API_KEY;
        else if (pName === 'gemini') savedKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      } else {
        this.syncToEnv(pName, savedKey);
      }

      const isConnected = this.isLocalAgent(pName)
        ? this.binaryAvailable(pName)
        : Boolean(savedKey);
      const savedOrDefault = savedModel === 'default' && pName === 'opencode' ? config.model : savedModel;

      this.providers.set(pName, {
        config: {
          ...config,
          model: savedOrDefault || config.model,
          apiKey: savedKey,
          isAvailable: this.isLocalAgent(pName) ? isConnected : config.isAvailable,
        },
        status: isConnected ? 'connected' : 'disconnected',
        totalTokens: 0,
      });
    }
  }

  getProvider(name: ProviderName): ProviderState | undefined {
    return this.providers.get(name);
  }

  getAllProviders(): Map<ProviderName, ProviderState> {
    return new Map(this.providers);
  }

  /** Returns providers that can serve requests (cloud keys or detected local agents). */
  getConnectedProviders(): Map<ProviderName, ProviderState> {
    const map = new Map<ProviderName, ProviderState>();
    for (const [name] of this.providers) {
      if (this.hasApiKey(name)) map.set(name, this.providers.get(name)!);
    }
    return map;
  }

  getFirstConnectedProvider(): ProviderName | null {
    if (this.hasApiKey(DEFAULT_PROVIDER)) return DEFAULT_PROVIDER;
    for (const name of this.fallbackOrder) {
      if (name === 'ollama') continue;
      if (this.hasApiKey(name)) return name;
    }
    for (const name of LOCAL_AGENTS) {
      if (this.hasApiKey(name)) return name;
    }
    return null;
  }

  hasApiKey(name: ProviderName): boolean {
    if (this.isProviderDisabled(name)) return false;
    if (this.isLocalAgent(name)) return this.binaryAvailable(name);
    const p = this.providers.get(name);
    return Boolean(p?.config.apiKey && p.status === 'connected');
  }

  isConfigured(name: ProviderName): boolean {
    if (name === 'ollama') return true;
    return this.hasApiKey(name);
  }

  setApiKey(name: ProviderName, key: string): void {
    if (this.isLocalAgent(name) || this.isProviderDisabled(name)) return;
    const trimmed = key.trim();
    this.config.set(`apiKeys.${name}`, trimmed);
    this.syncToEnv(name, trimmed);

    const provider = this.providers.get(name);
    if (provider) {
      provider.config.apiKey = trimmed;
      provider.status = 'connected';
    }
  }

  removeApiKey(name: ProviderName): void {
    if (this.isLocalAgent(name)) return;
    this.config.delete(`apiKeys.${name}`);
    this.clearFromEnv(name);

    const provider = this.providers.get(name);
    if (provider) {
      provider.config.apiKey = undefined;
      provider.status = 'disconnected';
    }
  }

  getApiKey(name: ProviderName): string | undefined {
    const provider = this.providers.get(name);
    if (provider?.config.apiKey) return provider.config.apiKey;
    if (name === 'claude') return process.env.ANTHROPIC_API_KEY;
    if (name === 'groq') return process.env.GROQ_API_KEY;
    if (name === 'codex') return process.env.OPENAI_API_KEY;
    if (name === 'gemini') return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    return undefined;
  }

  getMaskedKey(name: ProviderName): string {
    if (this.isLocalAgent(name)) return '(local CLI)';
    const key = this.getApiKey(name);
    if (!key) return '(not connected)';
    if (key.length <= 8) return '****';
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
  }

  /** Detect a provider from the shape of an API key, like opencode. */
  detectProviderFromKey(rawKey: string): ProviderName | null {
    const key = rawKey.trim();
    if (!key) return null;
    if (key.startsWith('gsk_')) return 'groq';
    if (key.startsWith('sk-ant-')) return 'claude';
    if (key.startsWith('AIza')) return 'gemini';
    if (key.startsWith('sk-or-')) return null;
    if (key.startsWith('sk-')) return 'codex';
    return null;
  }

  /** Curated + configured model IDs for a provider, de-duplicated. */
  getModelsFor(name: ProviderName): string[] {
    if (this.isProviderDisabled(name)) return [];
    if (this.isLocalAgent(name)) {
      const configured = this.providers.get(name)?.config.model;
      const extracted = this.localModelCache.get(name) ?? [];
      if (!this.localModelCache.has(name)) void this.extractLocalModels(name);
      return [...new Set([configured ?? 'default', ...extracted].filter(Boolean) as string[])];
    }
    const provider = this.providers.get(name);
    const configured = provider?.config.model;
    return [...new Set([configured, ...(PROVIDER_MODELS[name] ?? [])].filter(Boolean) as string[])];
  }

  getSavedProvider(): ProviderName | null {
    const saved = this.config.get('activeProvider') as ProviderName | undefined;
    if (saved && this.providers.has(saved) && !this.isProviderDisabled(saved) && this.isConfigured(saved)) return saved;
    return null;
  }

  setActiveProvider(name: ProviderName | null): void {
    if (name && this.isProviderDisabled(name)) return;
    if (name) this.config.set('activeProvider', name);
    else this.config.delete('activeProvider');
  }

  setModel(name: ProviderName, model: string): void {
    const trimmed = model.trim();
    if (!trimmed) return;
    const provider = this.providers.get(name);
    if (!provider) return;
    provider.config.model = trimmed;
    this.config.set(`models.${name}`, trimmed);
  }

  getActiveProvider(current: ProviderName | null): ProviderState | null {
    if (current) {
      const provider = this.providers.get(current);
      if (provider && (this.isConfigured(current) || current === 'ollama')) {
        return provider;
      }
    }

    const first = this.getFirstConnectedProvider();
    if (first) return this.providers.get(first)!;

    return null;
  }

  isProviderAvailable(name: ProviderName): boolean {
    return this.isConfigured(name);
  }

  isLocalAgentName(name: ProviderName): boolean {
    return this.isLocalAgent(name);
  }

  getProviderDisplayName(name: ProviderName | null): string {
    if (!name) return 'No Model';
    return this.providers.get(name)?.config.displayName ?? name;
  }

  updateProviderStatus(name: ProviderName, status: ProviderStatus): void {
    const provider = this.providers.get(name);
    if (provider) {
      provider.status = status;
    }
  }

  // ── Fabric helpers ──────────────────────────────────────────────────────

  /** Ordered live providers for fallback routing. */
  getFallbackChain(exclude?: ProviderName): ProviderName[] {
    return this.fallbackOrder.filter((n) => {
      if (exclude && n === exclude) return false;
      if (this.isProviderDisabled(n)) return false;
      const p = this.providers.get(n);
      return Boolean(p?.config.apiKey && p.status === 'connected');
    });
  }

  /** All live providers for fan-out (parallel ask). */
  getFanoutSet(): ProviderName[] {
    return this.getFallbackChain();
  }

  /** Cheapest-first routing for distilled (small-contract) tasks. */
  pickCheapest(): ProviderName | null {
    const cheapFirst: ProviderName[] = ['groq', 'gemini', 'codex', 'claude', 'ollama'];
    for (const n of cheapFirst) {
      if (this.isProviderDisabled(n)) continue;
      const p = this.providers.get(n);
      if (p?.config.apiKey && p.status === 'connected') return n;
    }
    return null;
  }

  getFabricSummary(): { live: ProviderName[]; strategy: FabricStrategy; cheapest: ProviderName | null } {
    const live = this.getFallbackChain();
    return { live, strategy: live.length > 1 ? 'fanout' : 'fallback', cheapest: this.pickCheapest() };
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

export const providerManager = new ProviderManager();
