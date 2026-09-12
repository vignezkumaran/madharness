import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from '../theme.js';

interface StatusBarProps {
  status: 'online' | 'processing' | 'error';
  provider?: string | null;
  tokens: number;
  totalTokens?: number;
  time: string;
  errorText?: string;
  hasModelsConnected?: boolean;
  branch?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({ 
  status, 
  provider, 
  tokens, 
  totalTokens = 100000,
  time, 
  errorText,
  hasModelsConnected = false,
  branch = 'master',
}) => {
  let statusDot = hasModelsConnected ? (
    <Box gap={1}>
      <Text color={THEME.highlight}>●</Text>
      <Text color={THEME.white} bold>{provider || 'Connected'}</Text>
    </Box>
  ) : (
    <Box gap={1}>
      <Text color={THEME.textDim}>○</Text>
      <Text color={THEME.textDim}>No Model</Text>
      <Text color={THEME.primary}>/login</Text>
    </Box>
  );

  if (status === 'processing') {
    statusDot = (
      <Box gap={1}>
        <Text color={THEME.primary}>⚡</Text>
        <Text color={THEME.accent} bold>Thinking...</Text>
      </Box>
    );
  } else if (status === 'error') {
    statusDot = (
      <Box gap={1}>
        <Text color={THEME.white} bold>✖</Text>
        <Text color={THEME.white} bold>Alert</Text>
      </Box>
    );
  }

  // Token meter in violet
  const pct = Math.min(100, Math.max(0, Math.round((tokens / totalTokens) * 100)));
  const filled = Math.min(6, Math.floor(pct / 16.6));
  const empty = 6 - filled;
  const bar = '■'.repeat(filled) + '░'.repeat(empty);

  const sep = <Text color={THEME.borderSubtle}> │ </Text>;

  return (
    <Box flexDirection="row" justifyContent="space-between" width="100%">
      <Box flexDirection="row" alignItems="center">
        {statusDot}
        {sep}
        <Box gap={1} alignItems="center">
          <Text color={THEME.primary}>[{bar}]</Text>
          <Text color={THEME.textMuted}>{tokens.toLocaleString()} tok</Text>
        </Box>
        {sep}
        <Box gap={1} alignItems="center">
          <Text color={THEME.textDim}>⏱ {time}</Text>
        </Box>
        {sep}
        <Box gap={1} alignItems="center">
          <Text color={THEME.textDim}>git:({branch})</Text>
        </Box>
      </Box>

      {status === 'error' && errorText ? (
        <Box paddingX={1}>
          <Text color={THEME.white} bold>[{errorText}]</Text>
        </Box>
      ) : (
        <Box flexDirection="row" gap={2}>
          <Text color={THEME.textDim}><Text color={THEME.accent}>^T</Text> Tools</Text>
          <Text color={THEME.textDim}><Text color={THEME.accent}>^P</Text> Models</Text>
          <Text color={THEME.textDim}><Text color={THEME.accent}>^D</Text> DAG</Text>
          <Text color={THEME.textDim}><Text color={THEME.accent}>^H</Text> Help</Text>
        </Box>
      )}
    </Box>
  );
};

