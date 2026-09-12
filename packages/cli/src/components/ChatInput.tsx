import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { THEME } from '../theme.js';

interface ChatInputProps {
  onSubmit: (value: string) => void;
  isProcessing: boolean;
  providerName?: string | null;
  awaitingLoginProvider?: string | null;
}

interface CommandSuggestion {
  cmd: string;
  desc: string;
}

const SLASH_COMMANDS: CommandSuggestion[] = [
  { cmd: '/help', desc: 'Documentation & keyboard shortcuts' },
  { cmd: '/models', desc: 'Switch or inspect connected AI models' },
  { cmd: '/login', desc: 'Authenticate model: /login groq (or claude)' },
  { cmd: '/block', desc: 'Block & remove a model from harness' },
  { cmd: '/tools', desc: 'View Jira, Git & MCP tool integrations' },
  { cmd: '/git status', desc: 'Check git branch and uncommitted files' },
  { cmd: '/git diff', desc: 'Inspect unstaged code changes' },
  { cmd: '/jira issue', desc: 'Fetch Jira ticket details (e.g. /jira issue PROJ-1)' },
  { cmd: '/jira create', desc: 'Create a new Jira issue' },
  { cmd: '/dag', desc: 'Run deterministic 4-stage agent pipeline' },
  { cmd: '/clear', desc: 'Clear chat conversation history' },
  { cmd: '/exit', desc: 'Exit MAD developer harness' },
];

export const ChatInput: React.FC<ChatInputProps> = ({ 
  onSubmit, 
  isProcessing, 
  providerName,
  awaitingLoginProvider,
}) => {
  const [value, setValue] = useState('');

  const handleSubmit = (val: string) => {
    if (val.trim()) {
      onSubmit(val.trim());
      setValue('');
    }
  };

  const isLoggingIn = Boolean(awaitingLoginProvider);

  // Suggestions logic for Claude Code slash autocomplete
  const showSuggestions = !isLoggingIn && (value.startsWith('/') || value.startsWith('@'));
  const filterTerm = value.toLowerCase();
  const matchingSuggestions = showSuggestions
    ? SLASH_COMMANDS.filter(s => s.cmd.toLowerCase().startsWith(filterTerm) || s.cmd.toLowerCase().includes(filterTerm.slice(1))).slice(0, 5)
    : [];

  return (
    <Box flexDirection="column" width="100%">
      {/* ── Claude Code Slash Command Autocomplete Overlay ────────────────── */}
      {showSuggestions && matchingSuggestions.length > 0 && (
        <Box 
          flexDirection="column" 
          borderStyle="round" 
          borderColor={THEME.borderDim} 
          paddingX={1} 
          marginBottom={0}
        >
          <Box marginBottom={0} justifyContent="space-between">
            <Text color={THEME.accent} bold>✦ Claude Commands</Text>
            <Text color={THEME.textDim}>Press Enter to run</Text>
          </Box>
          {matchingSuggestions.map((item, idx) => (
            <Box key={idx} gap={2}>
              <Box width={16}>
                <Text color={THEME.highlight} bold>{item.cmd}</Text>
              </Box>
              <Text color={THEME.textMuted}>{item.desc}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* ── Main Input Box ───────────────────────────────────────────────── */}
      <Box 
        flexDirection="column" 
        borderStyle="round" 
        borderColor={isLoggingIn ? THEME.highlight : isProcessing ? THEME.borderDim : THEME.border} 
        paddingX={1} 
        paddingY={0}
      >
        <Box alignItems="center">
          {isLoggingIn ? (
            <Box marginRight={1} gap={1}>
              <Text color={THEME.highlight} bold>🔑 [{awaitingLoginProvider}]</Text>
              <Text color={THEME.primary} bold>❯</Text>
            </Box>
          ) : (
            <Box marginRight={1} gap={1} alignItems="center">
              {providerName ? (
                <Text color={THEME.accent} bold>[{providerName.toLowerCase()}]</Text>
              ) : null}
              <Text color={THEME.primary} bold>❯</Text>
            </Box>
          )}

          <Box flexGrow={1}>
            <TextInput
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
              placeholder={
                isProcessing 
                  ? "Thinking with model..." 
                  : isLoggingIn 
                    ? `Paste your ${awaitingLoginProvider} API key and press Enter (or /cancel)` 
                    : "Ask anything, run a task, or type / for commands..."
              }
            />
          </Box>
        </Box>
      </Box>

      {/* ── Bottom Key Hint Bar ─────────────────────────────────────────── */}
      <Box paddingX={1} marginTop={0} justifyContent="space-between">
        {isLoggingIn ? (
          <Text color={THEME.textDim}>
            <Text color={THEME.highlight} bold>↵ Submit Key</Text> to authenticate  ·  <Text color={THEME.textDim}>/cancel to abort</Text>
          </Text>
        ) : (
          <Box gap={1}>
            <Text color={THEME.textDim}>
              <Text color={THEME.highlight}>↵</Text> Send
            </Text>
            <Text color={THEME.borderSubtle}>·</Text>
            <Text color={THEME.textDim}>
              <Text color={THEME.highlight}>/</Text> Commands
            </Text>
            <Text color={THEME.borderSubtle}>·</Text>
            <Text color={THEME.textDim}>
              <Text color={THEME.accent}>^T</Text> Tools & Jira
            </Text>
            <Text color={THEME.borderSubtle}>·</Text>
            <Text color={THEME.textDim}>
              <Text color={THEME.accent}>^P</Text> Models
            </Text>
            <Text color={THEME.borderSubtle}>·</Text>
            <Text color={THEME.textDim}>
              <Text color={THEME.accent}>^D</Text> DAG
            </Text>
            <Text color={THEME.borderSubtle}>·</Text>
            <Text color={THEME.textDim}>
              <Text color={THEME.accent}>^H</Text> Help
            </Text>
            <Text color={THEME.borderSubtle}>·</Text>
            <Text color={THEME.textDim}>
              <Text color={THEME.textDim}>^C</Text> Exit
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

