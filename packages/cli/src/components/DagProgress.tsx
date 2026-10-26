import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from '../theme.js';
import type { DagProgress as DagProgressState } from '../agent/dag-runner.js';

const BAR_WIDTH = 24;

export const DagProgress: React.FC<{ progress: DagProgressState }> = ({ progress }) => {
  const color = progress.failed ? THEME.danger : THEME.primary;
  const ratio = progress.total > 0 ? Math.min(1, progress.stage / progress.total) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
      flexShrink={0}
    >
      <Box>
        <Text color={color} bold>[{bar}]</Text>
        <Text color={THEME.white} bold> {progress.stage}/{progress.total}: </Text>
        <Text color={color} bold>{progress.label}</Text>
        {progress.failed ? <Text color={THEME.danger} bold> · halted</Text> : null}
      </Box>
      {progress.detail ? (
        <Text color={progress.failed ? THEME.danger : THEME.textDim} wrap="truncate-end">
          {progress.detail}
        </Text>
      ) : null}
    </Box>
  );
};
