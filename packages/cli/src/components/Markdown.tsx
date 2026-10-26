import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from '../theme.js';

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<Text key={`${keyPrefix}-b-${index++}`} bold color={THEME.white}>{token.slice(2, -2)}</Text>);
    } else if (token.startsWith('`')) {
      nodes.push(<Text key={`${keyPrefix}-c-${index++}`} color={THEME.accent} backgroundColor={THEME.codeBg}>{token.slice(1, -1)}</Text>);
    }
    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export const Markdown: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let codeLines: string[] = [];
  let inCode = false;
  let codeLang = '';

  const flushCode = (key: string) => {
    if (codeLines.length === 0 && !inCode) return;
    blocks.push(
      <Box
        key={key}
        flexDirection="column"
        borderStyle="round"
        borderColor={THEME.borderDim}
        paddingX={1}
        marginY={0}
      >
        {codeLang ? <Text color={THEME.textDim}>{codeLang}</Text> : null}
        {codeLines.map((line, index) => (
          <Text key={index} color={THEME.text}>{line || ' '}</Text>
        ))}
      </Box>
    );
    codeLines = [];
    codeLang = '';
  };

  lines.forEach((line, index) => {
    const key = `md-${index}`;
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeLang = fence[1] ?? '';
      } else {
        inCode = false;
        flushCode(key);
      }
      return;
    }

    if (inCode) {
      codeLines.push(line);
      return;
    }

    if (!line.trim()) {
      blocks.push(<Text key={key}> </Text>);
      return;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(
        <Text key={key} bold color={level <= 2 ? THEME.primary : THEME.accent}>
          {heading[2]}
        </Text>
      );
      return;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      blocks.push(
        <Box key={key} flexDirection="row">
          <Text color={THEME.primary}>• </Text>
          <Text color={THEME.text}>{inline(bullet[1]!, key)}</Text>
        </Box>
      );
      return;
    }

    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered) {
      blocks.push(
        <Box key={key} flexDirection="row">
          <Text color={THEME.primary}>{numbered[1]}. </Text>
          <Text color={THEME.text}>{inline(numbered[2]!, key)}</Text>
        </Box>
      );
      return;
    }

    if (line.startsWith('> ')) {
      blocks.push(
        <Box key={key} paddingLeft={1} borderStyle="single" borderColor={THEME.borderDim} borderTop={false} borderRight={false} borderBottom={false}>
          <Text color={THEME.textMuted}>{inline(line.slice(2), key)}</Text>
        </Box>
      );
      return;
    }

    blocks.push(<Text key={key} color={THEME.text}>{inline(line, key)}</Text>);
  });

  if (inCode) flushCode('md-code-end');

  return <Box flexDirection="column">{blocks}</Box>;
};
