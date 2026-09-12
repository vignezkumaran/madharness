import React from 'react';
import { Box, Text } from 'ink';
import { toolRegistry, jiraClient, mcpManager } from '../tools/registry.js';
import { THEME } from '../theme.js';

export const ToolsView: React.FC = () => {
  const tools = toolRegistry.getTools();
  const jiraConf = jiraClient.getConfig();
  const isJiraConnected = jiraClient.isConnected();
  const mcpServers = mcpManager.getServers();

  return (
    <Box flexDirection="column" padding={1}>
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <Box marginBottom={1} justifyContent="space-between">
        <Box gap={1} alignItems="center">
          <Text bold color={THEME.primary}>⚡ Tool Integrations & MCP</Text>
          <Text color={THEME.borderSubtle}>│</Text>
          <Text color={THEME.highlight} bold>{tools.length} Tools Active</Text>
        </Box>
        <Text color={THEME.textDim}>Claude Tool Protocols</Text>
      </Box>

      {/* ── AST Deterministic Engine Card ─────────────────────────────────── */}
      <Box 
        flexDirection="column" 
        marginBottom={1} 
        paddingX={1} 
        paddingY={0} 
        borderStyle="round" 
        borderColor={THEME.border} 
      >
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text bold color={THEME.white}>🌳 AST Context Pruner</Text>
            <Text color={THEME.highlight} bold>[92.8% Savings]</Text>
          </Box>
          <Text color={THEME.accent}>Built-in Engine</Text>
        </Box>
        <Text color={THEME.textMuted}>
          Extracts function signatures and type contracts, pruning implementation bodies to minimize prompt tokens.
        </Text>
      </Box>

      {/* ── Jira Card ─────────────────────────────────────────────────────── */}
      <Box 
        flexDirection="column" 
        marginBottom={1} 
        paddingX={1} 
        paddingY={0} 
        borderStyle="round" 
        borderColor={isJiraConnected ? THEME.highlight : THEME.borderDim}
      >
        <Box justifyContent="space-between">
          <Box gap={1} alignItems="center">
            <Text bold color={THEME.white}>📌 Atlassian Jira</Text>
            {isJiraConnected ? (
              <Text color={THEME.highlight} bold>● Connected</Text>
            ) : (
              <Text color={THEME.textDim}>○ Disconnected</Text>
            )}
          </Box>
          <Text color={THEME.textDim}>{jiraConf.host || 'host not configured'}</Text>
        </Box>
        <Box marginTop={0} flexDirection="column">
          <Box gap={2}>
            <Text color={THEME.primary}>/jira issue &lt;KEY&gt;</Text>
            <Text color={THEME.textMuted}>Fetch ticket details (e.g. /jira issue PROJ-101)</Text>
          </Box>
          <Box gap={2}>
            <Text color={THEME.primary}>/jira create &lt;title&gt;</Text>
            <Text color={THEME.textMuted}>Create issue on active board</Text>
          </Box>
          <Box gap={2}>
            <Text color={THEME.accent}>/jira config</Text>
            <Text color={THEME.textDim}>host=&lt;url&gt; email=&lt;user&gt; token=&lt;token&gt;</Text>
          </Box>
        </Box>
      </Box>

      {/* ── Version Control (Git) ─────────────────────────────────────────── */}
      <Box 
        flexDirection="column" 
        marginBottom={1} 
        paddingX={1} 
        paddingY={0} 
        borderStyle="round" 
        borderColor={THEME.borderDim}
      >
        <Box justifyContent="space-between">
          <Text bold color={THEME.white}>🔀 Git Repository Tools</Text>
          <Text color={THEME.accent}>Active Repository</Text>
        </Box>
        <Box marginTop={0} flexDirection="column">
          <Box gap={2}>
            <Text color={THEME.primary}>/git status</Text>
            <Text color={THEME.textMuted}>Inspect modified & untracked files</Text>
          </Box>
          <Box gap={2}>
            <Text color={THEME.primary}>/git diff</Text>
            <Text color={THEME.textMuted}>Show unstaged diff in terminal</Text>
          </Box>
        </Box>
      </Box>

      {/* ── MCP Servers ───────────────────────────────────────────────────── */}
      <Box 
        flexDirection="column" 
        paddingX={1} 
        paddingY={0} 
        borderStyle="round" 
        borderColor={THEME.borderDim}
      >
        <Box justifyContent="space-between">
          <Box gap={1} alignItems="center">
            <Text bold color={THEME.white}>🔌 Model Context Protocol (MCP)</Text>
            <Text color={THEME.textDim}>({mcpServers.length} Servers)</Text>
          </Box>
          <Text color={THEME.textDim}>Anthropic Protocol</Text>
        </Box>
        <Box marginTop={0} flexDirection="column">
          {mcpServers.length === 0 ? (
            <Text color={THEME.textDim}>No external MCP servers added yet.</Text>
          ) : (
            mcpServers.map(s => (
              <Box key={s.id} gap={1}>
                <Text color={THEME.primary}>• {s.name}:</Text>
                <Text color={THEME.white}>{s.command}</Text>
              </Box>
            ))
          )}
          <Box marginTop={0} gap={2}>
            <Text color={THEME.primary}>/mcp add &lt;name&gt; &lt;command&gt;</Text>
            <Text color={THEME.textDim}>Connect stdio MCP server</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

