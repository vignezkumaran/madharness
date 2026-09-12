import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { StatusBar } from './StatusBar.js';
import { ChatHistory } from './ChatHistory.js';
import { ChatInput } from './ChatInput.js';
import { ProgressDisplay } from './ProgressDisplay.js';
import { ProviderSelector } from './ProviderSelector.js';
import { HelpView } from './HelpView.js';
import { ToolsView } from './ToolsView.js';
import { useMAD } from '../hooks/useMAD.js';
import { providerManager } from '../providers/manager.js';
import { THEME } from '../theme.js';

export const App = () => {
  const { exit } = useApp();
  const { 
    state, 
    dispatch,
    sendMessage, 
    getSessionDuration,
  } = useMAD();

  const {
    messages,
    isProcessing,
    currentProvider,
    awaitingLoginProvider,
    tokenUsage,
    dagNodes,
    error,
    view,
  } = state;
  
  const [sessionTime, setSessionTime] = useState('0:00:00');

  useEffect(() => {
    const timer = setInterval(() => {
      setSessionTime(getSessionDuration());
    }, 1000);
    return () => clearInterval(timer);
  }, [getSessionDuration]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
    if (key.escape) {
      if (view !== 'chat') {
        dispatch({ type: 'SET_VIEW', payload: 'chat' });
      }
    }
    if (key.ctrl && input === 'h') {
      dispatch({ type: 'SET_VIEW', payload: view === 'help' ? 'chat' : 'help' });
    }
    if (key.ctrl && input === 'p') {
      dispatch({ type: 'SET_VIEW', payload: view === 'providers' ? 'chat' : 'providers' });
    }
    if (key.ctrl && input === 't') {
      dispatch({ type: 'SET_VIEW', payload: (view as string) === 'tools' ? 'chat' : ('tools' as any) });
    }
    if (key.ctrl && input === 'd') {
      dispatch({ type: 'SET_VIEW', payload: view === 'dag' ? 'chat' : 'dag' });
    }
  });

  const handleSubmit = async (text: string) => {
    await sendMessage(text);
  };

  const currentProviderName = currentProvider 
    ? providerManager.getProviderDisplayName(currentProvider) 
    : null;

  return (
    <Box flexDirection="column" minHeight={26} width="100%">
      {/* ── Top Header Bar (Claude Code Style) ────────────────────────────── */}
      <Box 
        paddingX={1} 
        paddingY={0} 
        justifyContent="space-between" 
        borderBottomColor={THEME.borderSubtle} 
        borderStyle="single" 
        borderTop={false} 
        borderLeft={false} 
        borderRight={false}
      >
        <Box gap={1} alignItems="center">
          <Text bold color={THEME.primary}>⚡ MAD</Text>
          <Text color={THEME.borderSubtle}>│</Text>
          <Text bold color={THEME.white}>Claude Code Architecture</Text>
          <Text color={THEME.textDim}>v0.1.0</Text>
        </Box>
        <Box gap={1} alignItems="center">
          <Text color={THEME.textDim}>Active:</Text>
          {currentProviderName ? (
            <Text color={THEME.highlight} bold>[{currentProviderName}]</Text>
          ) : (
            <Text color={THEME.textDim}>[No model · /login]</Text>
          )}
          <Text color={THEME.borderSubtle}>│</Text>
          <Text color={THEME.textDim}>~/MAD</Text>
        </Box>
      </Box>

      {/* ── Navigation Tabs (Violet & Monochrome Active Indicators) ────────── */}
      <Box paddingX={1} paddingY={0} gap={2}>
        <Box>
          <Text 
            bold={view === 'chat'} 
            color={view === 'chat' ? THEME.white : THEME.textDim}
          >
            {view === 'chat' ? '◈ 1 Chat' : '  1 Chat'}
          </Text>
        </Box>
        <Box>
          <Text 
            bold={(view as string) === 'tools'} 
            color={(view as string) === 'tools' ? THEME.white : THEME.textDim}
          >
            {(view as string) === 'tools' ? '◈ 2 Tools (^T)' : '  2 Tools (^T)'}
          </Text>
        </Box>
        <Box>
          <Text 
            bold={view === 'providers'} 
            color={view === 'providers' ? THEME.white : THEME.textDim}
          >
            {view === 'providers' ? '◈ 3 Models (^P)' : '  3 Models (^P)'}
          </Text>
        </Box>
        <Box>
          <Text 
            bold={view === 'dag'} 
            color={view === 'dag' ? THEME.white : THEME.textDim}
          >
            {view === 'dag' ? '◈ 4 Pipeline (^D)' : '  4 Pipeline (^D)'}
          </Text>
        </Box>
        <Box>
          <Text 
            bold={view === 'help'} 
            color={view === 'help' ? THEME.white : THEME.textDim}
          >
            {view === 'help' ? '◈ 5 Help (^H)' : '  5 Help (^H)'}
          </Text>
        </Box>
      </Box>

      <Box paddingX={1}>
        <Text color={THEME.borderSubtle}>────────────────────────────────────────────────────────────────────────────────</Text>
      </Box>

      {/* ── Main Content Area ─────────────────────────────────────────────── */}
      <Box flexGrow={1} flexDirection="column" paddingX={1}>
        {view === 'chat' && (
          <ChatHistory 
            messages={messages} 
            isProcessing={isProcessing} 
            currentProvider={currentProviderName || undefined} 
          />
        )}
        {(view as string) === 'tools' && <ToolsView />}
        {view === 'help' && <HelpView />}
        {(view === 'providers' || view === 'config') && <ProviderSelector currentProvider={currentProvider} />}
        {view === 'dag' && <ProgressDisplay nodes={dagNodes} isVisible={true} />}
      </Box>

      <Box paddingX={1}>
        <Text color={THEME.borderSubtle}>────────────────────────────────────────────────────────────────────────────────</Text>
      </Box>

      {/* ── Status Bar ────────────────────────────────────────────────────── */}
      <Box paddingX={1} marginBottom={0}>
        <StatusBar 
          status={error ? 'error' : isProcessing ? 'processing' : 'online'} 
          provider={currentProviderName}
          tokens={tokenUsage.used}
          totalTokens={tokenUsage.budget}
          time={sessionTime}
          errorText={error || undefined}
          hasModelsConnected={Boolean(currentProvider)}
          branch="master"
        />
      </Box>

      {/* ── Chat Input ────────────────────────────────────────────────────── */}
      <Box paddingX={1} marginTop={0}>
        <ChatInput 
          onSubmit={handleSubmit} 
          isProcessing={isProcessing} 
          providerName={currentProvider} 
          awaitingLoginProvider={awaitingLoginProvider}
        />
      </Box>
    </Box>
  );
};

