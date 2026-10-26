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
  version: '0.3.0',
  pipeline: {
    nodes: [
      {
        role: 'distill' as AgentRole,
        displayName: '◈ Distill · Contract Engine',
        maxRetries: 1,
        timeoutMs: 15000,
        dependsOn: [],
      },
      {
        role: 'architect' as AgentRole,
        displayName: '⬡ Architect · Mesh Peer',
        maxRetries: 3,
        timeoutMs: 30000,
        dependsOn: ['distill' as AgentRole],
      },
      {
        role: 'coder' as AgentRole,
        displayName: '⬣ Coder · Mesh Peer',
        maxRetries: 3,
        timeoutMs: 60000,
        dependsOn: ['architect' as AgentRole],
      },
      {
        role: 'verifier' as AgentRole,
        displayName: '⬔ Verifier · Mesh Peer',
        maxRetries: 3,
        timeoutMs: 30000,
        dependsOn: ['coder' as AgentRole],
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
    default: 'groq',
    fallbackOrder: ['groq', 'gemini', 'codex', 'claude', 'ollama'],
  },
};
