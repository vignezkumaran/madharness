import type { DAGNodeConfig, AgentRole } from '../dag/types.js';

export interface MADConfig {
  version: string;
  pipeline: {
    nodes: DAGNodeConfig[];
    circuitBreaker: {
      maxRetries: number;
      backoffMs: number;
    };
  };
  ast: {
    keepDocstrings: boolean;
    keepComments: boolean;
    keepConstants: boolean;
  };
  providers: {
    default: string;
    fallbackOrder: string[];
  };
}

export const defaultConfig: MADConfig = {
  version: '0.1.0',
  pipeline: {
    nodes: [
      {
        role: 'architect' as AgentRole,
        displayName: 'Architect',
        maxRetries: 3,
        timeoutMs: 30000,
        dependsOn: [],
      },
      {
        role: 'coder' as AgentRole,
        displayName: 'Coder',
        maxRetries: 3,
        timeoutMs: 60000,
        dependsOn: ['architect' as AgentRole],
      },
      {
        role: 'sandbox' as AgentRole,
        displayName: 'Sandbox',
        maxRetries: 3,
        timeoutMs: 45000,
        dependsOn: ['coder' as AgentRole],
      },
      {
        role: 'debugger' as AgentRole,
        displayName: 'Debugger',
        maxRetries: 3,
        timeoutMs: 30000,
        dependsOn: ['sandbox' as AgentRole],
      },
    ],
    circuitBreaker: {
      maxRetries: 3,
      backoffMs: 1000,
    },
  },
  ast: {
    keepDocstrings: false,
    keepComments: false,
    keepConstants: true,
  },
  providers: {
    default: 'claude',
    fallbackOrder: ['claude', 'gemini', 'groq', 'codex', 'ollama'],
  },
};
