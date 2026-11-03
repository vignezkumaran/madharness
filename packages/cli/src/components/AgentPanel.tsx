import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from '../theme.js';
import type { AgentView } from '../hooks/useHarness.js';

export const AgentPanel: React.FC<{ agents: AgentView[]; log: string[] }> = ({ agents, log }) => {
    const running = agents.filter(agent => agent.status === 'running').length;
    return <Box width={32} flexShrink={0} flexDirection="column" borderStyle="single" borderColor={THEME.borderDim} paddingX={1} overflow="hidden">
        <Text color={THEME.primary} bold>Agents · {running} running</Text>
        {agents.length === 0 ? <Text color={THEME.textDim}>No agents running</Text> : agents.slice(-6).map(agent =>
            <Box key={agent.id} flexDirection="column" flexShrink={0}>
                <Text color={agent.status === 'running' ? THEME.primary : THEME.textMuted} wrap="truncate-end">{agent.title} · {agent.status}</Text>
                {agent.current ? <Text color={THEME.textDim} wrap="truncate-end">  {agent.current}</Text> : null}
            </Box>)}
        <Text color={THEME.accent}>Activity &amp; handoffs</Text>
        {log.length ? log.slice(-6).map((line, index) => <Text key={index} color={THEME.textDim} wrap="truncate-end">{line}</Text>) : <Text color={THEME.textDim}>No agent activity yet</Text>}
    </Box>;
};
