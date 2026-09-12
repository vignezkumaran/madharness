import chalk from 'chalk';
import type { ProviderResponse } from '../types.js';
import { providerManager } from './manager.js';

interface GroqResponse {
  id?: string;
  choices: Array<{
    message: {
      content: string;
      reasoning?: string;
    };
  }>;
  usage: {
    total_tokens: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

const CANDIDATE_MODELS = [
  'qwen/qwen3.8-27b',
  'qwen/qwen3.6-27b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];

export async function sendToGroq(
  message: string,
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
): Promise<ProviderResponse> {
  const apiKey = process.env.GROQ_API_KEY || providerManager.getApiKey('groq');

  if (!apiKey) {
    throw new Error('Groq is not connected. Type groq/login to paste your API key.');
  }

  // Format messages
  const messages = history && history.length > 0
    ? [...history, { role: 'user', content: message }]
    : [
        {
          role: 'system',
          content: 'You are MAD Assistant, an expert AI software engineer and architect powered by Groq high-speed inference. Provide clear, concise, accurate code and explanations.',
        },
        { role: 'user', content: message },
      ];

  let lastError: Error | null = null;

  for (const model of CANDIDATE_MODELS) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 4096,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // If model not found, rate limited (429), or too large (413), try next candidate model
        if (response.status === 404 || errorText.includes('model_not_found')) {
          continue;
        }
        if (response.status === 413 || response.status === 429) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`Groq API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as GroqResponse;
      const content = data.choices?.[0]?.message?.content || '';
      const tokens = data.usage?.total_tokens || Math.floor(content.length / 4);

      return {
        content,
        tokens,
        model,
        provider: 'groq',
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // If it's a network or auth error, don't keep looping
      if (lastError.message.includes('401') || lastError.message.includes('invalid_api_key')) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('Failed to connect to Groq API with available models.');
}
