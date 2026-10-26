import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { THEME } from '../theme.js';
import type { AgentView, HarnessState } from '../hooks/useHarness.js';

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

const AgentRow: React.FC<{ agent: AgentView; active: boolean }> = ({ agent, active }) => {
  const icon = agent.status === 'done'
    ? <Text color={THEME.primary}>✓</Text>
    : agent.status === 'failed'
      ? <Text color={THEME.danger}>✗</Text>
      : agent.status === 'running'
        ? <Text color={THEME.primary}>{active ? <Spinner type="dots" /> : '●'}</Text>
        : <Text color={THEME.textDim}>○</Text>;

  const color = agent.status === 'failed'
    ? THEME.danger
    : agent.status === 'running'
      ? THEME.white
      : agent.status === 'done'
        ? THEME.textMuted
        : THEME.textDim;

  const detail = agent.current
    ? truncate(agent.current.replace(/\s+/g, ' '), 96)
    : agent.summary
      ? truncate(agent.summary.replace(/\s+/g, ' '), 96)
      : '';

  return (
    <Box flexDirection="column">
      <Box>
        <Text>  </Text>
        {icon}
        <Text color={THEME.textDim}> </Text>
        <Text color={THEME.accent} bold>{agent.role}</Text>
        <Text color={THEME.textDim}> · </Text>
        <Text color={color}>{truncate(agent.title, 54)}</Text>
        {agent.provider ? <Text color={THEME.textDim}>  {agent.provider}</Text> : null}
        {agent.tokens ? <Text color={THEME.highlight}>  {agent.tokens.toLocaleString()}t</Text> : null}
      </Box>
      {detail ? (
        <Box paddingLeft={5}>
          <Text color={THEME.textDim}>{detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

export const AgentPanel: React.FC<{ state: HarnessState; approvalPending: boolean }> = ({ state, approvalPending }) => {
  if (!state.busy && !state.plan) return null;

  const agents = state.agentOrder.map((id) => state.agents[id]).filter(Boolean) as AgentView[];
  const done = agents.filter((agent) => agent.status === 'done' || agent.status === 'skipped').length;
  const running = agents.some((agent) => agent.status === 'running');
  const activeId = agents.find((agent) => agent.status === 'running')?.id;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={approvalPending ? THEME.highlight : state.busy ? THEME.borderDim : THEME.borderSubtle}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={THEME.primary} bold>{state.busy ? <Spinner type="dots" /> : '◈'}</Text>
          <Text color={THEME.white} bold>{state.busy ? 'Mesh running' : 'Last mesh run'}</Text>
          {state.plan ? <Text color={THEME.textDim}>{done}/{state.plan.tasks.length} tasks</Text> : null}
        </Box>
        <Box gap={1}>
          <Text color={THEME.highlight}>{state.tokens.toLocaleString()} tok</Text>
          {state.lastRunMs ? <Text color={THEME.textDim}>{Math.round(state.lastRunMs / 100) / 10}s</Text> : null}
        </Box>
      </Box>

      <Box marginTop={0}>
        <Text color={THEME.textDim}>
          {approvalPending ? 'Waiting for your approval…' : truncate(state.phase, 110)}
        </Text>
      </Box>

      {agents.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {agents.slice(0, 7).map((agent) => (
            <AgentRow key={agent.id} agent={agent} active={agent.id === activeId && running} />
          ))}
          {agents.length > 7 ? <Text color={THEME.textDim}>  …and {agents.length - 7} more</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
};
