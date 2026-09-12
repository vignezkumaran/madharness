import chalk from 'chalk';
import type { ProviderResponse } from '../types.js';

const RESPONSES: Record<string, string> = {
  help: `🏠 Ollama — Running locally on your hardware. No data leaves your machine.

I can help with:
• Private code generation — nothing sent to external servers
• Local model inference — full control over your data
• Offline-capable AI assistance
• Custom model fine-tuning support

Your data stays on your machine. Always.`,

  local: `Running entirely on your local hardware:

• **Model**: Llama 3 (8B parameters)
• **Runtime**: Ollama inference engine
• **Privacy**: Zero external API calls
• **Latency**: Direct hardware inference, no network overhead

All processing happens on-device. Your prompts and responses never leave your machine.`,

  privacy: `🔒 Privacy-first AI assistance:

Ollama guarantees:
1. **No data transmission** — All inference runs locally
2. **No logging** — No conversation data is stored externally
3. **No telemetry** — Zero tracking or analytics
4. **Full control** — You own the model and all outputs

Perfect for:
• Proprietary code analysis
• Sensitive data processing
• Air-gapped environments
• Compliance-critical workloads`,

  default: `Processing locally on your hardware...

I've analyzed your request using the local Llama 3 model. Here's my approach:

Since everything runs on your machine, you get:
• **Zero latency** from network calls
• **Complete privacy** for sensitive code
• **Full reproducibility** with the local model

My recommendation is to start with a clean implementation pattern that's easy to test and iterate on. Would you like me to generate some starter code?`,
};

interface OllamaResponse {
  response: string;
}

function mockResponse(message: string): ProviderResponse {
  let content = RESPONSES['default']!;
  for (const [keyword, response] of Object.entries(RESPONSES)) {
    if (keyword !== 'default' && message.toLowerCase().includes(keyword)) {
      content = response;
      break;
    }
  }

  return {
    content,
    tokens: Math.floor(content.length / 4) + Math.floor(Math.random() * 20),
    model: 'llama3',
    provider: 'ollama',
  };
}

let loggedError = false;

export async function sendToOllama(message: string): Promise<ProviderResponse> {
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama3',
        prompt: message,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaResponse;
    const content = data.response || '';
    // Estimate tokens roughly
    const tokens = Math.floor(content.length / 4);

    return {
      content,
      tokens,
      model: 'llama3',
      provider: 'ollama',
    };
  } catch (error) {
    if (!loggedError) {
      console.error(chalk.dim(`  ⚠ Could not reach local Ollama (${error instanceof Error ? error.message : String(error)}), using mock mode`));
      loggedError = true;
    }
    return mockResponse(message);
  }
}
