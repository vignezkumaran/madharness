import chalk from 'chalk';
import type { ProviderResponse } from '../types.js';

const RESPONSES: Record<string, string> = {
  help: `🧠 Codex o1-preview — Advanced reasoning model with chain-of-thought analysis.

I excel at:
• Deep logical reasoning and analysis
• Complex algorithm design
• Multi-step problem decomposition
• Mathematical proofs and formal verification
• Architecture decision trade-off analysis

I take a bit longer but provide thoroughly reasoned responses.`,

  reason: `Let me think through this step by step...

**Step 1: Problem Decomposition**
Breaking the problem into sub-components for systematic analysis.

**Step 2: Constraint Analysis**
Identifying boundary conditions and edge cases.

**Step 3: Solution Synthesis**
Combining insights from steps 1-2 into a coherent approach.

**Conclusion:**
The optimal solution involves a divide-and-conquer strategy with memoization to avoid redundant computation. Time complexity: O(n log n), Space: O(n).`,

  algorithm: `Applying chain-of-thought reasoning to algorithm design:

\`\`\`typescript
/**
 * Optimal merge sort with early termination
 * Reasoning trace:
 * 1. Base case: arrays of length <= 1 are sorted
 * 2. Divide: split at midpoint for balanced recursion
 * 3. Conquer: recursively sort both halves
 * 4. Combine: merge with O(n) comparison
 */
function mergeSort<T>(arr: T[], compare: (a: T, b: T) => number): T[] {
  if (arr.length <= 1) return arr;
  
  const mid = Math.floor(arr.length / 2);
  const left = mergeSort(arr.slice(0, mid), compare);
  const right = mergeSort(arr.slice(mid), compare);
  
  return merge(left, right, compare);
}

function merge<T>(left: T[], right: T[], compare: (a: T, b: T) => number): T[] {
  const result: T[] = [];
  let i = 0, j = 0;
  
  while (i < left.length && j < right.length) {
    if (compare(left[i]!, right[j]!) <= 0) {
      result.push(left[i++]!);
    } else {
      result.push(right[j++]!);
    }
  }
  
  return [...result, ...left.slice(i), ...right.slice(j)];
}
\`\`\`

Verified correctness through mathematical induction on array length.`,

  default: `🧠 Engaging chain-of-thought reasoning...

**Analysis Phase:**
I've decomposed your request into its fundamental components and identified the key constraints.

**Reasoning Trace:**
1. Identified the core problem structure
2. Evaluated 3 potential approaches
3. Selected the optimal strategy based on complexity analysis

**Recommendation:**
The most robust approach uses a layered architecture with clear separation of concerns. Each layer handles one responsibility, making the system testable and maintainable.

Shall I elaborate on any specific reasoning step?`,
};

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage: {
    total_tokens: number;
  };
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
    tokens: Math.floor(content.length / 4) + Math.floor(Math.random() * 80),
    model: 'o1-preview',
    provider: 'codex',
  };
}

let loggedMissingKey = false;

import { providerManager } from './manager.js';

export async function sendToCodex(message: string): Promise<ProviderResponse> {
  const apiKey = process.env.OPENAI_API_KEY || providerManager.getApiKey('codex');

  if (!apiKey) {
    if (!loggedMissingKey) {
      console.error(chalk.dim('  ⚠ No API key for codex, using mock mode'));
      loggedMissingKey = true;
    }
    return mockResponse(message);
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: message }],
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    const content = data.choices?.[0]?.message?.content || '';
    const tokens = data.usage?.total_tokens || 0;

    return {
      content,
      tokens,
      model: 'gpt-4o',
      provider: 'codex',
    };
  } catch (error) {
    console.error(chalk.dim(`  ⚠ API error (${error instanceof Error ? error.message : String(error)}), using mock mode`));
    return mockResponse(message);
  }
}
