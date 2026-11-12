import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from '../theme.js';
import { Markdown } from './Markdown.js';
import type { TranscriptEntry } from '../hooks/useHarness.js';

export const HarnessEntry: React.FC<{ entry: TranscriptEntry }> = ({ entry }) => {
  if (entry.kind === 'user') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={THEME.primary} bold>❯ </Text>
          <Text color={THEME.white} bold>{entry.content}</Text>
        </Box>
      </Box>
    );
  }

  if (entry.kind === 'assistant') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={THEME.primary} bold>◈ {entry.title??'MAD'}</Text>
          <Text color={THEME.textDim}> agent</Text>
        </Box>
        <Box paddingLeft={2} flexDirection="column">
          <Markdown content={entry.content} />
        </Box>
      </Box>
    );
  }

  if (entry.kind === 'error') {
    return (
      <Box flexDirection="column" marginBottom={1} paddingLeft={1} borderStyle="single" borderColor={THEME.danger} borderTop={false} borderRight={false} borderBottom={false}>
        <Text color={THEME.danger} bold>✖ {entry.title ?? 'error'}</Text>
        <Text color={THEME.text}>{entry.content}</Text>
      </Box>
    );
  }

  if (entry.kind === 'tool') {
    const color = entry.status === 'error' ? THEME.danger : THEME.primary;
    const status = entry.status === 'error' ? '✖ Failed' : entry.status === 'running' ? '◐ Running' : '✓ Finished';
    const time = new Date(entry.at).toLocaleTimeString('en-GB');
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={color} paddingX={1}>
        <Text color={color} bold>[{time}] {entry.title} · {status}</Text>
        <Text color={THEME.textMuted}>{entry.content}</Text>
      </Box>
    );
  }

  if (entry.kind === 'agent') {
    return (
      <Box flexDirection="column" marginBottom={1} paddingLeft={1} borderStyle="single" borderColor={THEME.borderDim} borderTop={false} borderRight={false} borderBottom={false}>
        <Box>
          <Text color={entry.status === 'error' ? THEME.danger : THEME.primary} bold>{entry.status === 'error' ? '✖ ' : entry.status === 'ok' ? '✓ ' : '◇ '}</Text>
          <Text color={THEME.accent} bold>{entry.title}</Text>
          {entry.meta ? <Text color={THEME.textDim}> · {entry.meta}</Text> : null}
        </Box>
        <Box paddingLeft={2}>
          <Text color={THEME.text}>{entry.content}</Text>
        </Box>
      </Box>
    );
  }

  if (entry.kind === 'bus') {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Box>
          <Text color={THEME.highlight}>⇄ </Text>
          <Text color={THEME.highlight} bold>{entry.title ?? 'mesh'}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color={THEME.textMuted}>{entry.content}</Text>
        </Box>
      </Box>
    );
  }

  if (entry.kind === 'diff') {
    const lines = entry.content.split('\n').slice(0, 40);
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={THEME.accent} bold>± {entry.title ?? 'diff'}</Text>
        <Box flexDirection="column" paddingLeft={1}>
          {lines.map((line, index) => {
            const color = line.startsWith('+') && !line.startsWith('+++')
              ? THEME.primary
              : line.startsWith('-') && !line.startsWith('---')
                ? THEME.danger
                : THEME.textDim;
            return <Text key={index} color={color}>{line || ' '}</Text>;
          })}
          {entry.content.split('\n').length > 40 ? <Text color={THEME.textDim}>…diff truncated</Text> : null}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {entry.title ? (
        <Text color={THEME.accent} bold>
          {entry.title.startsWith('login') ? '🔑 ' : entry.title.startsWith('workspace') ? '⌂ ' : '◇ '}
          {entry.title}
        </Text>
      ) : null}
      <Box paddingLeft={entry.title ? 2 : 0}>
        <Text color={THEME.textMuted}>{entry.content}</Text>
      </Box>
    </Box>
  );
};
