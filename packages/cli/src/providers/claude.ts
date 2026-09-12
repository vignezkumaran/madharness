import chalk from 'chalk';
import type { ProviderResponse } from '../types.js';

const RESPONSES: Record<string, string> = {
  login: `Here's a secure login API implementation:

\`\`\`typescript
import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const router = Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  
  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  
  const token = jwt.sign(
    { userId: user.id },
    process.env.JWT_SECRET!,
    { expiresIn: '24h' }
  );
  
  res.json({ token, user: { id: user.id, email: user.email } });
});
\`\`\`

This includes password hashing with bcrypt and JWT token generation.`,

  help: `I can help you with:
• Writing code in any language
• Debugging and error analysis
• Architecture and system design
• Code review and optimization
• API design and documentation

Just describe what you need and I'll provide a detailed response.`,

  test: `Here's a comprehensive testing approach:

\`\`\`typescript
import { describe, it, expect } from 'vitest';

describe('UserService', () => {
  it('should create a new user', async () => {
    const user = await service.create({
      email: 'test@example.com',
      name: 'Test User',
    });
    expect(user.id).toBeDefined();
    expect(user.email).toBe('test@example.com');
  });

  it('should reject duplicate emails', async () => {
    await expect(
      service.create({ email: 'existing@example.com' })
    ).rejects.toThrow('Email already exists');
  });
});
\`\`\``,

  api: `I recommend a RESTful API design with the following structure:

• **GET /api/v1/resources** — List all resources with pagination
• **POST /api/v1/resources** — Create a new resource
• **GET /api/v1/resources/:id** — Get a specific resource
• **PUT /api/v1/resources/:id** — Update a resource
• **DELETE /api/v1/resources/:id** — Delete a resource

Each endpoint should return consistent JSON responses with proper HTTP status codes.`,

  default: `I understand your request. Let me analyze the best approach...

Based on my analysis, I'd recommend a modular architecture that separates concerns effectively. The key components would be:

1. **Data Layer** — Clean interfaces for data access
2. **Business Logic** — Core domain rules isolated from infrastructure
3. **API Layer** — RESTful endpoints with proper validation

Would you like me to elaborate on any specific aspect?`,
};

interface AnthropicResponse {
  content: Array<{ text: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
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
    tokens: Math.floor(content.length / 4) + Math.floor(Math.random() * 50),
    model: 'claude-3.5-sonnet',
    provider: 'claude',
  };
}

let loggedMissingKey = false;

import { providerManager } from './manager.js';

export async function sendToClaude(message: string): Promise<ProviderResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY || providerManager.getApiKey('claude');

  if (!apiKey) {
    if (!loggedMissingKey) {
      console.error(chalk.dim('  ⚠ No API key for claude, using mock mode'));
      loggedMissingKey = true;
    }
    return mockResponse(message);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const content = data.content?.[0]?.text || '';
    const tokens = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    return {
      content,
      tokens,
      model: 'claude-3-5-sonnet-20241022',
      provider: 'claude',
    };
  } catch (error) {
    console.error(chalk.dim(`  ⚠ API error (${error instanceof Error ? error.message : String(error)}), using mock mode`));
    return mockResponse(message);
  }
}
