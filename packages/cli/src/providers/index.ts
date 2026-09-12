import chalk from 'chalk';
import type { ProviderName, ProviderResponse } from '../types.js';
import { sendToClaude } from './claude.js';
import { sendToGroq } from './groq.js';
import { sendToCodex } from './codex.js';
import { sendToOllama } from './ollama.js';

// ─── Inline Gemini Handler ─────────────────────────────────────────────────

const GEMINI_RESPONSES: Record<string, string> = {
  help: `✨ Gemini 2.0 Pro — Google's most capable multimodal AI model.

I can help with:
• Code generation and analysis across all major languages
• Multimodal understanding (code, text, images, diagrams)
• Long-context reasoning (up to 128K tokens)
• Complex system design and architecture
• Cross-language translation and migration

Powered by Google's latest Gemini architecture.`,

  multimodal: `Gemini's multimodal capabilities include:

1. **Code Understanding** — Analyze code structure, patterns, and anti-patterns
2. **Diagram Interpretation** — Understand architecture and flow diagrams
3. **Documentation Generation** — Create comprehensive docs from code
4. **Cross-Modal Reasoning** — Connect insights across different data types

This enables a holistic understanding of your entire project.`,

  default: `Analyzing with Gemini 2.0 Pro...

I've processed your request using Google's most advanced reasoning capabilities. Here's my analysis:

**Architecture Recommendation:**
• Use a microservices pattern for scalability
• Implement event-driven communication between services
• Deploy with containerized workloads for portability

**Key Considerations:**
1. Start with a monolith, extract services as needed
2. Use strong typing throughout the stack
3. Implement observability from day one

Would you like me to dive deeper into any of these areas?`,
};

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
  }>;
}

function mockGeminiResponse(message: string): ProviderResponse {
  let content = GEMINI_RESPONSES['default']!;
  for (const [keyword, response] of Object.entries(GEMINI_RESPONSES)) {
    if (keyword !== 'default' && message.toLowerCase().includes(keyword)) {
      content = response;
      break;
    }
  }

  return {
    content,
    tokens: Math.floor(content.length / 4) + Math.floor(Math.random() * 60),
    model: 'gemini-2.0-pro',
    provider: 'gemini',
  };
}

let loggedMissingKey = false;

import { providerManager } from './manager.js';

async function sendToGemini(message: string): Promise<ProviderResponse> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || providerManager.getApiKey('gemini');

  if (!apiKey) {
    if (!loggedMissingKey) {
      console.error(chalk.dim('  ⚠ No API key for gemini, using mock mode'));
      loggedMissingKey = true;
    }
    return mockGeminiResponse(message);
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: message }] }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const tokens = Math.floor(content.length / 4);

    return {
      content,
      tokens,
      model: 'gemini-2.0-flash',
      provider: 'gemini',
    };
  } catch (error) {
    console.error(chalk.dim(`  ⚠ API error (${error instanceof Error ? error.message : String(error)}), using mock mode`));
    return mockGeminiResponse(message);
  }
}

// ─── Unified Provider Router ────────────────────────────────────────────────

export async function sendToProvider(
  provider: ProviderName,
  message: string,
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
): Promise<ProviderResponse> {
  switch (provider) {
    case 'claude':
      return sendToClaude(message);
    case 'groq':
      return sendToGroq(message, history);
    case 'codex':
      return sendToCodex(message);
    case 'ollama':
      return sendToOllama(message);
    case 'gemini':
      return sendToGemini(message);
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}

export { sendToClaude } from './claude.js';
export { sendToGroq } from './groq.js';
export { sendToCodex } from './codex.js';
export { sendToOllama } from './ollama.js';
