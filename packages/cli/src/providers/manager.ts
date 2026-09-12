import Conf from 'conf';
import type { ProviderName, ProviderConfig, ProviderState, ProviderStatus } from '../types.js';

// ─── Default Provider Configurations ────────────────────────────────────────

const DEFAULT_CONFIGS: Record<ProviderName, ProviderConfig> = {
  groq: {
    name: 'groq',
    displayName: 'Groq Llama 3.3 70B',
    model: 'llama-3.3-70b-versatile',
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
};

// ─── Provider Manager ───────────────────────────────────────────────────────

export class ProviderManager {
  private config: Conf<Record<string, unknown>>;
  private providers: Map<ProviderName, ProviderState>;
  private fallbackOrder: ProviderName[] = ['groq', 'claude', 'gemini', 'codex', 'ollama'];

  constructor() {
    this.config = new Conf({ projectName: 'mad-harness' });
    this.providers = new Map();
    this.initializeProviders();
  }

  public resolveProviderName(raw: string): ProviderName | null {
    const clean = raw.trim().toLowerCase();
    if (clean === 'groq' || clean === 'grok') return 'groq';
    if (clean === 'claude' || clean === 'anthropic') return 'claude';
    if (clean === 'codex' || clean === 'openai' || clean === 'gpt' || clean === 'gpt4' || clean === 'gpt-4o') return 'codex';
    if (clean === 'gemini' || clean === 'google') return 'gemini';
    if (clean === 'ollama' || clean === 'local') return 'ollama';
    return null;
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

      const isConnected = Boolean(savedKey);

      this.providers.set(pName, {
        config: { ...config, apiKey: savedKey },
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

  /** Returns ONLY providers that have a configured API key */
  getConnectedProviders(): Map<ProviderName, ProviderState> {
    const map = new Map<ProviderName, ProviderState>();
    for (const [name, provider] of this.providers) {
      if (provider.config.apiKey && provider.status === 'connected') {
        map.set(name, provider);
      }
    }
    return map;
  }

  getFirstConnectedProvider(): ProviderName | null {
    for (const name of this.fallbackOrder) {
      const p = this.providers.get(name);
      if (p?.config.apiKey && p.status === 'connected') {
        return name;
      }
    }
    return null;
  }

  hasApiKey(name: ProviderName): boolean {
    const p = this.providers.get(name);
    return Boolean(p?.config.apiKey);
  }

  setApiKey(name: ProviderName, key: string): void {
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
    const key = this.getApiKey(name);
    if (!key) return '(not connected)';
    if (key.length <= 8) return '****';
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
  }

  getActiveProvider(current: ProviderName | null): ProviderState | null {
    if (current) {
      const provider = this.providers.get(current);
      if (provider && provider.status === 'connected' && provider.config.apiKey) {
        return provider;
      }
    }

    const first = this.getFirstConnectedProvider();
    if (first) return this.providers.get(first)!;

    return null;
  }

  isProviderAvailable(name: ProviderName): boolean {
    const p = this.providers.get(name);
    return Boolean(p?.status === 'connected' && p.config.apiKey);
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
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

export const providerManager = new ProviderManager();
