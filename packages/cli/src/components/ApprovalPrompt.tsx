import React from 'react';
import { Box, Text, useInput } from 'ink';
import { THEME } from '../theme.js';
import type { ApprovalDecision, ApprovalRequest } from '../agent/types.js';

interface ApprovalPromptProps {
  request: ApprovalRequest;
  onRespond: (decision: ApprovalDecision) => void;
}

export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({ request, onRespond }) => {
  useInput((input, key) => {
    const value = input.toLowerCase();
    if (value === 'y') onRespond('once');
    else if (value === 'a') onRespond('always');
    else if (value === 'n' || key.escape) onRespond('deny');
  });

  const lines = (request.detail ?? '').split('\n').slice(0, 14);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.highlight}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text color={THEME.highlight} bold>⚠ Approval required</Text>
        <Text color={THEME.textDim}>{request.tool}</Text>
      </Box>
      <Text color={THEME.white} bold>{request.summary}</Text>
      {lines.length > 0 ? (
        <Box flexDirection="column" paddingLeft={1} marginTop={0}>
          {lines.map((line, index) => (
            <Text key={index} color={THEME.textMuted}>{line || ' '}</Text>
          ))}
          {((request.detail ?? '').split('\n').length > 14) ? <Text color={THEME.textDim}>…</Text> : null}
        </Box>
      ) : null}
      <Box marginTop={1} gap={2}>
        <Text color={THEME.primary} bold>[y] allow once</Text>
        <Text color={THEME.highlight} bold>[a] always this key</Text>
        <Text color={THEME.textMuted} bold>[n/esc] deny</Text>
      </Box>
    </Box>
  );
};
