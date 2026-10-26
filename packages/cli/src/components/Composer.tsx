import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { THEME } from '../theme.js';
import type { ProviderName } from '../types.js';

interface ComposerProps {
  onSubmit: (value: string) => void;
  busy: boolean;
  awaitingProvider: ProviderName | null;
  awaitingKey: boolean;
  provider: ProviderName | null;
  history: string[];
  focus: boolean;
  onFocusAgents: () => void;
}

interface CommandHint {
  cmd: string;
  desc: string;
  arg?: boolean;
}

const COMMANDS: CommandHint[] = [
  { cmd: '/help', desc: 'Show commands and keys' },
  { cmd: '/dag', desc: 'Run hidden 4-stage DAG pipeline', arg: true },
  { cmd: '/plan', desc: 'Show the current DAG plan' },
  { cmd: '/agents', desc: 'Browse worker status and roles' },
  { cmd: '/diff', desc: 'Show working tree diff' },
  { cmd: '/status', desc: 'Session and provider status' },
  { cmd: '/modelprovider', desc: 'Choose a model provider' },
  { cmd: '/models', desc: 'Choose a model' },
  { cmd: '/model', desc: 'Switch provider or model', arg: true },
  { cmd: '/login', desc: 'Connect a provider key (auto-detects)', arg: true },
  { cmd: '/logout', desc: 'Remove a provider key', arg: true },
  { cmd: '/distill', desc: 'Distill a file contract', arg: true },
  { cmd: '/cwd', desc: 'Show or change workspace', arg: true },
  { cmd: '/permissions', desc: 'Show or clear allow rules' },
  { cmd: '/clear', desc: 'Clear screen and transcript' },
  { cmd: '/cancel', desc: 'Stop the running chat or DAG' },
  { cmd: '/exit', desc: 'Quit MAD' },
];

export const Composer: React.FC<ComposerProps> = ({
  onSubmit,
  busy,
  awaitingProvider,
  awaitingKey,
  provider,
  history,
  focus,
  onFocusAgents,
}) => {
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(0);
  const [histIndex, setHistIndex] = useState(-1);

  const awaitingSecret = Boolean(awaitingProvider) || awaitingKey;
  const showSuggestions = !awaitingSecret && value.startsWith('/') && !value.includes(' ');
  const matching = showSuggestions
    ? COMMANDS.filter((command) => command.cmd.startsWith(value.toLowerCase())).slice(0, 6)
    : [];

  useEffect(() => {
    setSelected(0);
  }, [value]);

  useInput((input, key) => {
    if (!focus || awaitingSecret) return;

    if (showSuggestions && matching.length > 0) {
      if (key.upArrow) {
        setSelected((current) => (current - 1 + matching.length) % matching.length);
        return;
      }
      if (key.downArrow) {
        setSelected((current) => (current + 1) % matching.length);
        return;
      }
      if (key.tab) {
        const command = matching[selected];
        if (command) setValue(command.arg ? `${command.cmd} ` : command.cmd);
        return;
      }
    }

    if (key.tab && !awaitingSecret) {
      onFocusAgents();
      return;
    }

    if (!showSuggestions && history.length > 0) {
      if (key.upArrow) {
        const next = histIndex === -1 ? history.length - 1 : Math.max(0, histIndex - 1);
        setHistIndex(next);
        setValue(history[next] ?? '');
        return;
      }
      if (key.downArrow) {
        if (histIndex === -1) return;
        const next = histIndex + 1;
        if (next >= history.length) {
          setHistIndex(-1);
          setValue('');
        } else {
          setHistIndex(next);
          setValue(history[next] ?? '');
        }
        return;
      }
    }
  }, { isActive: focus && !awaitingSecret });

  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text) return;

    if (showSuggestions && matching.length > 0 && !matching.some((command) => command.cmd === text)) {
      const command = matching[selected];
      if (command) {
        setValue(command.arg ? `${command.cmd} ` : command.cmd);
        return;
      }
    }

    setValue('');
    setHistIndex(-1);
    onSubmit(text);
  };

  if (busy) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={THEME.borderDim} paddingX={1}>
          <Text color={THEME.primary}>◈ </Text>
          <Text color={THEME.textMuted}>MAD is working. Press </Text>
          <Text color={THEME.highlight}>Esc</Text>
          <Text color={THEME.textMuted}> or </Text>
          <Text color={THEME.highlight}>Ctrl+C</Text>
          <Text color={THEME.textMuted}> to cancel.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {showSuggestions ? (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.borderSubtle} paddingX={1} marginBottom={0}>
          {matching.length > 0 ? matching.map((command, index) => (
            <Box key={command.cmd} gap={2}>
              <Text color={index === selected ? THEME.primary : THEME.textDim}>
                {index === selected ? '▸ ' : '  '}
                <Text color={index === selected ? THEME.white : THEME.textMuted} bold={index === selected}>
                  {command.cmd}
                </Text>
              </Text>
              <Text color={THEME.textDim}>{command.desc}</Text>
            </Box>
          )) : (
            <Text color={THEME.textDim}>No matching command. Press /help.</Text>
          )}
          <Text color={THEME.textDim}>Tab complete · ↑↓ select · Enter run</Text>
        </Box>
      ) : null}

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={awaitingSecret ? THEME.highlight : focus ? THEME.border : THEME.borderSubtle}
        paddingX={1}
      >
        <Box alignItems="center">
          {awaitingSecret ? (
            <Box marginRight={1} gap={1}>
              <Text color={THEME.highlight} bold>🔑 [{awaitingProvider ?? 'auto'}]</Text>
              <Text color={THEME.primary} bold>❯</Text>
            </Box>
          ) : (
            <Box marginRight={1} gap={1}>
              <Text color={THEME.accent} bold>[{provider ?? 'offline'}]</Text>
              <Text color={THEME.primary} bold>❯</Text>
            </Box>
          )}
          <Box flexGrow={1}>
            <TextInput
              value={value}
              onChange={(next) => {
                setValue(next);
                setHistIndex(-1);
              }}
              onSubmit={submit}
              mask={awaitingSecret ? '*' : undefined}
              focus={focus}
              placeholder={
                awaitingProvider
                  ? `Paste API key for ${awaitingProvider}`
                  : awaitingKey
                    ? 'Paste any provider API key (auto-detects provider)'
                    : 'Describe a task, ask a question, or type / for commands'
              }
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
