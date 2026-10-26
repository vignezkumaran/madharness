import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { THEME } from '../theme.js';
import { AGENT_ROLE_INFO } from '../agent/roles.js';
import { providerManager } from '../providers/manager.js';
import type { AgentRole } from '../agent/types.js';
import type { AgentView, HarnessState } from '../hooks/useHarness.js';

interface SidePanelProps {
  state: HarnessState;
  width: number;
  height: number;
  focused: boolean;
  onInspectAgent: (agentId: string) => void;
  onInspectRole: (role: AgentRole) => void;
  onBlur: () => void;
}

type SideRow =
  | { id: string; kind: 'agent'; agent: AgentView }
  | { id: string; kind: 'role'; role: AgentRole; label: string; detail: string };

const STATUS_ICON: Record<string, string> = {
  running: '●',
  done: '✓',
  failed: '✗',
  skipped: '–',
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function statusColor(status: string): string {
  if (status === 'running') return THEME.primary;
  if (status === 'done') return THEME.success;
  if (status === 'failed') return THEME.danger;
  return THEME.textDim;
}

function logColor(kind: string): string {
  if (kind === 'critique') return THEME.danger;
  if (kind === 'result' || kind === 'summary') return THEME.success;
  if (kind === 'plan') return THEME.accent;
  if (kind === 'handoff') return THEME.primary;
  if (kind === 'thought') return THEME.textMuted;
  return THEME.textDim;
}

const SectionTitle: React.FC<{ label: string; meta?: string }> = ({ label, meta }) => (
  <Box justifyContent="space-between">
    <Text color={THEME.accent} bold>{label}</Text>
    {meta ? <Text color={THEME.textDim}>{meta}</Text> : null}
  </Box>
);

export const SidePanel: React.FC<SidePanelProps> = ({
  state,
  width,
  height,
  focused,
  onInspectAgent,
  onInspectRole,
  onBlur,
}) => {
  const inner = Math.max(12, width - 4);
  const compact = height < 34;
  const agents = useMemo(
    () => state.agentOrder.map((id) => state.agents[id]).filter(Boolean) as AgentView[],
    [state.agentOrder, state.agents]
  );
  const activeAgent = agents.find((agent) => agent.status === 'running');

  const rows = useMemo<SideRow[]>(() => {
    if (agents.length > 0) {
      return agents.map((agent) => ({ id: `agent:${agent.id}`, kind: 'agent', agent }));
    }
    return AGENT_ROLE_INFO.map((info) => ({
      id: `role:${info.role}`,
      kind: 'role',
      role: info.role,
      label: info.label,
      detail: info.detail,
    }));
  }, [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && rows.some((row) => row.id === selectedId)) return;
    const running = rows.find((row) => row.kind === 'agent' && row.agent.status === 'running');
    setSelectedId(running?.id ?? rows[0]!.id);
  }, [rows, selectedId]);

  const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === selectedId));
  const selected = rows[selectedIndex];

  useInput((input, key) => {
    if (key.escape) {
      onBlur();
      return;
    }
    if (rows.length === 0) return;
    if (key.upArrow || input === 'k') {
      setSelectedId(rows[(selectedIndex - 1 + rows.length) % rows.length]!.id);
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedId(rows[(selectedIndex + 1) % rows.length]!.id);
      return;
    }
    if (key.return || input === '\r' || input === '\n') {
      if (selected?.kind === 'agent') onInspectAgent(selected.agent.id);
      else if (selected?.kind === 'role') onInspectRole(selected.role);
    }
  }, { isActive: focused });

  const windowSize = selected?.kind === 'role'
    ? (compact ? 3 : 6)
    : (compact ? 3 : 4);
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(windowSize / 2), rows.length - windowSize));
  const visible = rows.slice(start, start + windowSize);

  const connected = Array.from(new Set(
    agents.map((agent) => agent.provider).filter(Boolean) as string[]
  ));
  const done = agents.filter((agent) => agent.status === 'done' || agent.status === 'skipped').length;
  const activeProvider = state.provider;
  const providerConfig = activeProvider ? providerManager.getProvider(activeProvider) : null;
  const providerLabel = activeProvider
    ? providerManager.getProviderDisplayName(activeProvider)
    : 'no provider';
  const model = providerConfig?.config.model ?? '';
  const objective = state.objective || state.plan?.summary || 'terminal agent harness';
  const planTasks = state.plan?.tasks ?? [];
  const shownTasks = planTasks.slice(0, compact ? 2 : 5);
  const logEntries = state.busEntries.slice(-(compact ? 2 : 5));

  return (
    <Box
      width={width}
      height="100%"
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={THEME.borderSubtle}
      paddingLeft={1}
      overflowY="hidden"
    >
      <Box flexDirection="column" flexShrink={0}>
        <Text color={THEME.white} bold wrap="truncate-end">{clip(objective, inner)}</Text>
        <Text color={THEME.textDim} wrap="truncate-end">direct chat · hidden DAG</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <SectionTitle label="Context" meta={activeAgent ? 'live' : undefined} />
        <Text color={THEME.white}>{state.tokens.toLocaleString()} tokens</Text>
        <Text color={THEME.textMuted}>
          {agents.length > 0 ? `${done}/${agents.length} workers done` : 'no workers yet'}
        </Text>
        <Text color={THEME.textDim}>
          {connected.length > 0 ? `${connected.length} provider${connected.length === 1 ? '' : 's'} used` : 'ready when you are'}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <SectionTitle label="Fabric" meta={state.busy ? 'routing' : 'idle'} />
        <Text color={activeProvider ? THEME.primary : THEME.textDim} wrap="truncate-end">
          {activeProvider ? `● ${providerLabel}` : '○ no provider connected'}
        </Text>
        <Text color={THEME.textDim} wrap="truncate-end">
          {activeProvider ? clip(model ?? '', inner) : '/login to connect a provider'}
        </Text>
      </Box>

      {!compact ? (
        <>
          <Box flexDirection="column" marginTop={1} flexShrink={0}>
            <SectionTitle label="MCP" />
            <Text color={THEME.textDim}>○ no servers configured</Text>
          </Box>
          <Box flexDirection="column" marginTop={1} flexShrink={0}>
            <SectionTitle label="LSP" />
            <Text color={THEME.textDim}>○ diagnostics disabled</Text>
          </Box>
        </>
      ) : null}

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <SectionTitle label="Plan" meta={planTasks.length > 0 ? `${done}/${planTasks.length}` : undefined} />
        {shownTasks.length > 0 ? shownTasks.map((task) => {
          const icon = task.status === 'done' ? '✓' : task.status === 'failed' ? '✗' : task.status === 'running' ? '●' : '○';
          const color = statusColor(task.status);
          return (
            <Text key={task.id} color={color} wrap="truncate-end">
              {icon} {clip(`${task.role} · ${task.title}`, inner - 2)}
            </Text>
          );
        }) : (
          <Text color={THEME.textDim}>no plan yet</Text>
        )}
        {planTasks.length > shownTasks.length ? (
          <Text color={THEME.textDim}>…and {planTasks.length - shownTasks.length} more</Text>
        ) : null}
      </Box>

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <SectionTitle
          label="Agent log"
          meta={state.busEntries.length > 0 ? `${state.busEntries.length}` : 'empty'}
        />
        {logEntries.length > 0 ? logEntries.map((entry) => {
          const who = entry.role === 'user' ? 'user' : entry.role;
          return (
            <Text key={entry.id} color={THEME.textDim} wrap="truncate-end">
              <Text color={logColor(entry.kind)}>{entry.kind === 'critique' ? '✗ ' : entry.kind === 'plan' ? '◆ ' : '· '}</Text>
              <Text color={THEME.accent}>{clip(who, 9)}</Text>
              <Text color={THEME.textDim}>: </Text>
              <Text color={logColor(entry.kind)}>{clip(entry.content, inner - 12)}</Text>
            </Text>
          );
        }) : (
          <Text color={THEME.textDim}>waiting for agent activity</Text>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        <SectionTitle
          label="Agents"
          meta={agents.length > 0 ? `${done}/${agents.length}` : 'roles'}
        />
        <Text color={focused ? THEME.highlight : THEME.textDim} wrap="truncate-end">
          {focused ? '↑↓ select · Enter details · Tab/Esc back' : 'Tab to inspect workers'}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          {visible.map((row) => {
            const isSelected = row.id === selectedId;
            if (row.kind === 'agent') {
              const agent = row.agent;
              const icon = STATUS_ICON[agent.status] ?? '○';
              const current = agent.current || agent.summary || 'waiting for task';
              return (
                <Box key={row.id} flexDirection="column" marginBottom={0}>
                  <Text
                    color={isSelected ? THEME.white : THEME.textMuted}
                    bold={isSelected}
                    wrap="truncate-end"
                  >
                    {isSelected ? '▸ ' : '  '}
                    <Text color={statusColor(agent.status)}>{icon} </Text>
                    <Text color={THEME.accent} bold>{agent.role}</Text>
                    <Text color={THEME.textDim}> · {clip(agent.title, inner - 12)}</Text>
                  </Text>
                  <Text color={THEME.textDim} wrap="truncate-end">
                    {'    '}{clip(current, inner - 4)}
                  </Text>
                </Box>
              );
            }
            return (
              <Text
                key={row.id}
                color={isSelected ? THEME.white : THEME.textMuted}
                bold={isSelected}
                wrap="truncate-end"
              >
                {isSelected ? '▸ ' : '  '}
                <Text color={THEME.textDim}>○ </Text>
                <Text color={THEME.accent}>{row.label}</Text>
                <Text color={THEME.textDim}> · idle</Text>
              </Text>
            );
          })}
          {rows.length > windowSize ? (
            <Text color={THEME.textDim}>  {start + 1}–{Math.min(start + windowSize, rows.length)} of {rows.length}</Text>
          ) : null}
        </Box>

        {selected && !compact ? (
          <Box flexDirection="column" marginTop={1}>
            <SectionTitle label="Working on" />
            <Text color={THEME.white} wrap="wrap">
              {selected.kind === 'agent'
                ? clip(selected.agent.current || selected.agent.summary || 'Waiting for the supervisor to assign a task.', inner * 2)
                : clip(selected.detail, inner * 2)}
            </Text>
            {selected.kind === 'agent' ? (
              <Text color={THEME.textDim} wrap="truncate-end">
                {selected.agent.provider ? `${selected.agent.provider} · ` : ''}
                {selected.agent.tokens ? `${selected.agent.tokens.toLocaleString()} tok · ` : ''}
                {selected.agent.status}
              </Text>
            ) : (
              <Text color={THEME.textDim}>idle · no run yet</Text>
            )}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
};
