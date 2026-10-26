import type { AgentRole } from './types.js';

export interface AgentRoleInfo {
  role: AgentRole;
  label: string;
  detail: string;
}

export const AGENT_ROLE_INFO: AgentRoleInfo[] = [
  { role: 'supervisor', label: 'Supervisor', detail: 'Plans the task graph, routes providers, and gates completion.' },
  { role: 'architect', label: 'Architect', detail: 'Reads context and designs the smallest safe change.' },
  { role: 'coder', label: 'Coder', detail: 'Writes files and runs implementation tools in the workspace.' },
  { role: 'verifier', label: 'Verifier', detail: 'Runs tests, type checks, and acceptance checks.' },
  { role: 'researcher', label: 'Researcher', detail: 'Explores the codebase and reports facts to the mesh.' },
  { role: 'debugger', label: 'Debugger', detail: 'Diagnoses failures and proposes targeted fixes.' },
];
