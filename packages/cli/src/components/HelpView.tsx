import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from '../theme.js';

export const HelpView: React.FC = () => {
  const commands = [
    { category: 'AI Models & Authentication', items: [
      { cmd: 'groq/login', desc: 'Paste Groq API key to unlock Groq' },
      { cmd: 'claude/login', desc: 'Paste Anthropic key to unlock Claude' },
      { cmd: '/login <model>', desc: 'Interactive key prompt for any model' },
      { cmd: '/switch <model>', desc: 'Switch active model in harness' },
      { cmd: '/block <model>', desc: 'Revoke and remove model from harness' },
      { cmd: '/models', desc: 'List active and connected models' },
    ]},
    { category: 'Claude Tools & Integrations', items: [
      { cmd: '/tools', desc: 'Catalog of Jira, Git & MCP integrations' },
      { cmd: '/git status', desc: 'Inspect git working tree and branch' },
      { cmd: '/git diff', desc: 'Show unstaged git diff' },
      { cmd: '/jira issue <KEY>', desc: 'Fetch Jira ticket (e.g. /jira issue PROJ-1)' },
      { cmd: '/jira create', desc: 'Create a new Jira issue' },
      { cmd: '/jira config', desc: 'Configure host, email, and API token' },
      { cmd: '/mcp add <name>', desc: 'Register external MCP server' },
    ]},
    { category: 'Workflow & Orchestration', items: [
      { cmd: '<prompt>', desc: 'Send prompt directly to active model' },
      { cmd: '/dag', desc: 'Run 4-phase deterministic agent pipeline' },
      { cmd: '/clear', desc: 'Clear conversation message history' },
      { cmd: '/exit', desc: 'Exit MAD harness' },
    ]}
  ];

  const shortcuts = [
    { keys: 'Enter', desc: 'Submit prompt / command' },
    { keys: 'Esc', desc: 'Return to Chat view' },
    { keys: 'Ctrl+C', desc: 'Exit application' },
    { keys: 'Ctrl+H', desc: 'Toggle Help screen' },
    { keys: 'Ctrl+T', desc: 'Toggle Tools & Jira' },
    { keys: 'Ctrl+P', desc: 'Toggle Models' },
    { keys: 'Ctrl+D', desc: 'Toggle DAG pipeline' },
    { keys: '↑ / ↓', desc: 'Cycle input history' },
  ];

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Box gap={1} alignItems="center">
          <Text bold color={THEME.primary}>⚡ Claude Code Manual & Command Reference</Text>
          <Text color={THEME.borderSubtle}>│</Text>
          <Text color={THEME.highlight}>Esc to return to Chat</Text>
        </Box>
        <Text color={THEME.textDim}>Violet Edition</Text>
      </Box>

      <Box flexDirection="row" gap={2}>
        {/* Commands column */}
        <Box flexDirection="column" width="65%">
          {commands.map((cat, i) => (
            <Box 
              key={i} 
              flexDirection="column" 
              marginBottom={1} 
              paddingX={1} 
              paddingY={0} 
              borderStyle="round" 
              borderColor={THEME.borderDim}
            >
              <Text bold color={THEME.accent}>{cat.category}</Text>
              {cat.items.map((item, j) => (
                <Box key={j} gap={2} marginTop={0}>
                  <Box width={20}>
                    <Text color={THEME.highlight} bold>{item.cmd}</Text>
                  </Box>
                  <Text color={THEME.textMuted}>{item.desc}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>

        {/* Shortcuts column */}
        <Box flexDirection="column" width="35%">
          <Box 
            flexDirection="column" 
            paddingX={1} 
            paddingY={0} 
            borderStyle="round" 
            borderColor={THEME.borderDim}
          >
            <Text bold color={THEME.accent}>Keyboard Shortcuts</Text>
            {shortcuts.map((sc, i) => (
              <Box key={i} gap={1} marginTop={0}>
                <Box width={10}>
                  <Text color={THEME.primary} bold>{sc.keys}</Text>
                </Box>
                <Text color={THEME.textMuted}>{sc.desc}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

