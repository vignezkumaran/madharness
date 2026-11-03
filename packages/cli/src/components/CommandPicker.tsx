import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { THEME } from '../theme.js';
import type { PickerItem, PickerState, PickerStatus } from '../hooks/useHarness.js';

interface CommandPickerProps {
  picker: PickerState;
  onSelect: (item: PickerItem) => void;
  onCancel: () => void;
}

const WINDOW_SIZE = 8;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function statusIcon(status?: PickerStatus): string {
  switch (status) {
    case 'active':
      return '★';
    case 'connected':
      return '●';
    case 'running':
      return '●';
    case 'done':
      return '✓';
    case 'failed':
      return '✗';
    case 'skipped':
      return '–';
    default:
      return '○';
  }
}

function statusColor(status?: PickerStatus): string {
  switch (status) {
    case 'active':
      return THEME.primary;
    case 'connected':
      return THEME.accent;
    case 'running':
      return THEME.highlight;
    case 'done':
      return THEME.primary;
    case 'failed':
      return THEME.danger;
    default:
      return THEME.textDim;
  }
}

export const CommandPicker: React.FC<CommandPickerProps> = ({ picker, onSelect, onCancel }) => {
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const items = picker.kind === 'models' && query ? picker.items.filter(item => `${item.label} ${item.meta ?? ''}`.toLowerCase().includes(query.toLowerCase())) : picker.items;
  const count = items.length;

  useEffect(() => {
    setSelected(0);
  }, [picker.kind, picker.title, count, query]);

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (picker.kind === 'models' && (key.backspace || key.delete)) { setQuery(value => value.slice(0, -1)); return; }
    if (picker.kind === 'models' && input && !key.ctrl && !key.meta && !key.return && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab) { setQuery(value => value + input); return; }
    if (count === 0) {
      return;
    }

    if (key.upArrow || input === 'k') {
      setSelected((current) => (current - 1 + count) % count);
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelected((current) => (current + 1) % count);
      return;
    }
    if (key.return || input === '\r' || input === '\n') {
      const item = items[selected];
      if (item) onSelect(item);
      return;
    }
    if (key.escape) onCancel();
  });

  const start = Math.max(0, Math.min(selected - Math.floor(WINDOW_SIZE / 2), count - WINDOW_SIZE));
  const visible = items.slice(start, start + WINDOW_SIZE);
  const current = items[selected];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.border}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={THEME.primary} bold>◈ {picker.title}</Text>
          {picker.subtitle ? <Text color={THEME.textDim}>· {clip(picker.subtitle, 90)}</Text> : null}
        </Box>
        <Text color={THEME.textDim}>{count} option{count === 1 ? '' : 's'}</Text>
      </Box>
      {picker.kind === 'models' ? <Text color={THEME.textDim}>Search: {query || 'type to filter models'}</Text> : null}

      {count > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((item, index) => {
            const absolute = start + index;
            const active = absolute === selected;
            return (
              <Box key={item.id} flexDirection="column">
                <Box>
                  <Text color={active ? THEME.primary : THEME.textDim}>{active ? '▸ ' : '  '}</Text>
                  <Text color={statusColor(item.status)}>{statusIcon(item.status)} </Text>
                  <Text color={active ? THEME.white : THEME.textMuted} bold={active}>
                    {clip(item.label, 72)}
                  </Text>
                  {item.meta ? <Text color={THEME.textDim}>  {clip(item.meta, 86)}</Text> : null}
                </Box>
                {active && item.detail ? (
                  <Box paddingLeft={4}>
                    <Text color={THEME.textDim}>{clip(item.detail, 120)}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
          {count > WINDOW_SIZE ? (
            <Text color={THEME.textDim}>
              {' '}
              {start + 1}–{Math.min(start + WINDOW_SIZE, count)} of {count}
            </Text>
          ) : null}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={THEME.textDim}>{picker.empty ?? 'Nothing to show.'}</Text>
        </Box>
      )}

      <Box justifyContent="space-between" marginTop={1}>
        <Text color={THEME.textDim}>
          {count > 0 ? `↑↓ navigate · ${current ? clip(current.label, 48) : ''}` : 'Esc close'}
        </Text>
        <Text color={THEME.textDim}>Enter select · Esc close</Text>
      </Box>
    </Box>
  );
};
