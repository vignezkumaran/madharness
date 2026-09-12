import React from 'react';
import { Box, Text } from 'ink';
import { providerManager } from '../providers/manager.js';
import type { ProviderName } from '../types.js';
import { THEME } from '../theme.js';

interface ProviderSelectorProps {
  currentProvider?: ProviderName | null;
}

export const ProviderSelector: React.FC<ProviderSelectorProps> = ({ currentProvider }) => {
  const allProviders = providerManager.getAllProviders();
  const providerList = Array.from(allProviders.entries());
  const connectedCount = providerList.filter(([name]) => providerManager.hasApiKey(name)).length;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Box gap={1} alignItems="center">
          <Text bold color={THEME.primary}>⚡ Claude Model Registry</Text>
          <Text color={THEME.borderSubtle}>│</Text>
          <Text color={THEME.highlight} bold>{connectedCount} of {providerList.length} Connected</Text>
        </Box>
        <Text color={THEME.textDim}>Violet Minimalist Edition</Text>
      </Box>

      {/* ── Model Cards Grid ──────────────────────────────────────────────── */}
      <Box flexDirection="column" marginBottom={1}>
        {providerList.map(([name, p]) => {
          const isConnected = providerManager.hasApiKey(name);
          const isActive = name === currentProvider;
          const masked = isConnected ? providerManager.getMaskedKey(name) : 'No key set';

          let statusBadge = (
            <Box gap={1}>
              <Text color={THEME.textDim}>○</Text>
              <Text color={THEME.textDim}>Locked</Text>
            </Box>
          );

          if (isActive) {
            statusBadge = (
              <Box gap={1}>
                <Text color={THEME.highlight}>●</Text>
                <Text color={THEME.white} bold>Active</Text>
              </Box>
            );
          } else if (isConnected) {
            statusBadge = (
              <Box gap={1}>
                <Text color={THEME.accent}>✓</Text>
                <Text color={THEME.accent}>Ready</Text>
              </Box>
            );
          }

          return (
            <Box 
              key={name} 
              flexDirection="column" 
              marginBottom={1} 
              paddingX={1} 
              paddingY={0} 
              borderStyle="round" 
              borderColor={isActive ? THEME.border : isConnected ? THEME.borderDim : THEME.borderSubtle}
            >
              <Box justifyContent="space-between">
                <Box gap={1} alignItems="center">
                  <Text bold color={isActive ? THEME.white : isConnected ? THEME.light : THEME.textMuted}>
                    {p.config.displayName}
                  </Text>
                  <Text color={THEME.borderSubtle}>·</Text>
                  <Text color={THEME.textDim}>[{p.config.model}]</Text>
                </Box>
                {statusBadge}
              </Box>

              <Box justifyContent="space-between" marginTop={0}>
                <Box gap={2}>
                  <Text color={THEME.textDim}>Key: <Text color={isConnected ? THEME.glow : THEME.textDim}>{masked}</Text></Text>
                  <Text color={THEME.textDim}>Context: <Text color={THEME.textMuted}>{p.config.maxTokens?.toLocaleString() || '128,000'} tok</Text></Text>
                </Box>
                {!isConnected ? (
                  <Text color={THEME.accent}>type: {name}/login</Text>
                ) : !isActive ? (
                  <Text color={THEME.primary}>type: /switch {name}</Text>
                ) : (
                  <Text color={THEME.highlight}>Current Active Model</Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* ── Command Reference Bar ────────────────────────────────────────── */}
      <Box flexDirection="column" borderStyle="round" borderColor={THEME.borderDim} paddingX={1}>
        <Text color={THEME.accent} bold>Model Management Commands:</Text>
        <Box marginTop={0} gap={2}>
          <Text color={THEME.highlight}>/login &lt;provider&gt;</Text>
          <Text color={THEME.textMuted}>Connect API key (or type &lt;provider&gt;/login)</Text>
        </Box>
        <Box gap={2}>
          <Text color={THEME.highlight}>/switch &lt;provider&gt;</Text>
          <Text color={THEME.textMuted}>Switch active generation model</Text>
        </Box>
        <Box gap={2}>
          <Text color={THEME.white}>/block &lt;provider&gt;</Text>
          <Text color={THEME.textMuted}>Revoke API key and remove from harness</Text>
        </Box>
      </Box>
    </Box>
  );
};

