import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import * as os from 'os';
import { THEME } from '../theme.js';
import { useHarness, type TranscriptEntry } from '../hooks/useHarness.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { HarnessEntry } from './HarnessLog.js';
import { AgentPanel } from './AgentPanel.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { Composer } from './Composer.js';
import { CommandPicker } from './CommandPicker.js';
import { SidePanel } from './SidePanel.js';
import { DagProgress } from './DagProgress.js';

function shortCwd(cwd: string): string {
  const home = os.homedir();
  const shortened = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (shortened.length <= 42) return shortened;
  const parts = shortened.split('/');
  return `…/${parts.slice(Math.max(1, parts.length - 3)).join('/')}`;
}

const Header: React.FC<{
  cwd: string;
  branch: string;
  provider: string | null;
  columns: number;
}> = ({ cwd, branch, provider, columns }) => (
  <Box flexDirection="column" paddingX={1} flexShrink={0}>
    <Box justifyContent="space-between">
      <Box gap={1}>
        <Text color={THEME.primary} bold>◈ MAD</Text>
        <Text color={THEME.borderSubtle}>│</Text>
        <Text color={THEME.white} bold>terminal agent harness</Text>
        <Text color={THEME.textDim}>v0.3.0</Text>
      </Box>
      <Box gap={1}>
        <Text color={THEME.highlight}>chat</Text>
        <Text color={THEME.textDim}>·</Text>
        <Text color={THEME.primary}>dag</Text>
        <Text color={THEME.textDim}>·</Text>
        <Text color={THEME.accent}>fabric</Text>
      </Box>
    </Box>
    <Box justifyContent="space-between">
      <Text color={THEME.textDim}>
        ⌂ {shortCwd(cwd)}{branch ? <Text color={THEME.textDim}> · {branch}</Text> : null}
      </Text>
      <Text color={provider ? THEME.accent : THEME.textDim}>
        {provider ? `◉ ${provider}` : '○ no model'}
      </Text>
    </Box>
    <Text color={THEME.borderSubtle}>{'─'.repeat(Math.max(20, columns - 2))}</Text>
  </Box>
);

export const App = () => {
  const { exit } = useApp();
  const {
    state,
    approval,
    submit,
    cancel,
    respondApproval,
    elapsed,
    inspectAgent,
    inspectRole,
    selectPicker,
    closePicker,
  } = useHarness();
  const size = useTerminalSize();
  const [focus, setFocus] = useState<'composer' | 'agents'>('composer');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [, tick] = useState(0);
  const previousEntries = useRef(state.entries.length);

  const showSidebar = size.columns >= 100;
  const sidebarWidth = showSidebar
    ? Math.min(46, Math.max(36, Math.floor(size.columns * 0.33)))
    : 0;

  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (approval || state.picker) setFocus('composer');
  }, [approval, state.picker]);

  useEffect(() => {
    if (!showSidebar) setFocus('composer');
  }, [showSidebar]);

  useEffect(() => {
    setScrollOffset(0);
  }, [state.clearKey]);

  useEffect(() => {
    const delta = state.entries.length - previousEntries.current;
    if (delta > 0) {
      setScrollOffset((current) => current > 0 ? Math.min(state.entries.length - 1, current + delta) : 0);
    }
    previousEntries.current = state.entries.length;
  }, [state.entries.length]);

  const maxScroll = Math.max(0, state.entries.length - 1);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (state.busy) cancel();
      else exit();
      return;
    }

    if (approval) return;

    if (state.picker) return;

    if (key.tab) {
      if (focus === 'agents') {
        setFocus('composer');
        return;
      }
      if (state.busy) {
        setFocus('agents');
        return;
      }
      return;
    }

    if (key.pageUp) {
      setScrollOffset((current) => Math.min(maxScroll, current + 6));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((current) => Math.max(0, current - 6));
      return;
    }
    if (key.ctrl && input === 'l') {
      void submit('/clear');
      setScrollOffset(0);
      return;
    }
    if (key.ctrl && input === 'd') {
      void submit('/diff');
      return;
    }
    if (focus === 'agents' && key.escape) {
      setFocus('composer');
      return;
    }
    if (key.escape && state.busy) {
      cancel();
    }
  });

  const visibleEntries = useMemo(() => {
    const end = Math.max(0, state.entries.length - scrollOffset);
    const start = Math.max(0, end - 60);
    return state.entries.slice(start, end);
  }, [state.entries, scrollOffset]);

  const streamingEntry = useMemo<TranscriptEntry | null>(() => {
    if (state.streaming === undefined) return null;
    return {
      id: 'streaming',
      kind: 'assistant',
      title: 'MAD',
      content: state.streaming || '_Thinking…_',
      meta: state.phase,
      at: Date.now(),
    };
  }, [state.streaming, state.phase]);

  const providerLabel = state.provider ? (state.provider as string) : null;

  const scrollHint = scrollOffset > 0 ? ` · ▲ ${scrollOffset} older` : '';

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows} overflow="hidden">
      <Header cwd={state.cwd} branch={state.branch} provider={providerLabel} columns={size.columns} />

      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <Box
            flexDirection="column"
            flexGrow={1}
            justifyContent="flex-end"
            overflowY="hidden"
            paddingX={1}
          >
            {visibleEntries.length > 0 ? visibleEntries.map((entry) => (
              <Box key={entry.id} flexShrink={0}>
                <HarnessEntry entry={entry} />
              </Box>
            )) : (
              <Text color={THEME.textDim}>No output yet. Ask a question or type /help.</Text>
            )}
            {streamingEntry && scrollOffset === 0 ? (
              <Box key="streaming" flexShrink={0}>
                <HarnessEntry entry={streamingEntry} />
              </Box>
            ) : null}
          </Box>

          <Box flexDirection="column" paddingX={1} flexShrink={0}>
            {state.dag ? (
              <DagProgress progress={state.dag} />
            ) : !showSidebar ? (
              <AgentPanel state={state} approvalPending={Boolean(approval)} />
            ) : null}

            {approval ? (
              <ApprovalPrompt request={approval} onRespond={respondApproval} />
            ) : state.picker ? (
              <CommandPicker picker={state.picker} onSelect={selectPicker} onCancel={closePicker} />
            ) : (
              <Composer
                onSubmit={(value) => {
                  setScrollOffset(0);
                  void submit(value);
                }}
                busy={state.busy}
                awaitingProvider={state.awaitingProvider}
                awaitingKey={state.awaitingKey}
                provider={state.provider}
                history={state.history}
                focus={focus === 'composer'}
                onFocusAgents={() => setFocus('agents')}
              />
            )}

            <Box justifyContent="space-between" marginTop={0}>
              <Box gap={1}>
                <Text color={state.busy ? THEME.primary : THEME.textDim}>
                  {state.dag
                    ? state.dag.failed ? '◈ dag halted' : '◈ dag running'
                    : state.busy ? '◈ streaming' : '◈ ready'}
                </Text>
                <Text color={THEME.borderSubtle}>│</Text>
                <Text color={THEME.highlight}>{state.tokens.toLocaleString()} tok</Text>
                <Text color={THEME.borderSubtle}>│</Text>
                <Text color={THEME.textDim}>{elapsed()}</Text>
                {state.lastRunMs ? (
                  <>
                    <Text color={THEME.borderSubtle}>│</Text>
                    <Text color={THEME.textDim}>last {(state.lastRunMs / 1000).toFixed(1)}s</Text>
                  </>
                ) : null}
                {scrollHint ? <Text color={THEME.textDim}>{scrollHint}</Text> : null}
              </Box>
              <Text color={THEME.textDim}>
                {approval
                  ? 'y allow · a always · n deny'
                  : state.picker
                    ? '↑↓ navigate · Enter select · Esc close'
                    : focus === 'agents'
                      ? '↑↓ agent · Enter details · Tab/Esc composer'
                      : state.busy
                        ? 'Esc cancel · Tab agents · PgUp/PgDn scroll'
                        : showSidebar
                          ? 'Enter send · /dag <task> · Tab agents · PgUp/PgDn'
                          : 'Enter send · /dag <task> · /help · Ctrl+L clear'}
              </Text>
            </Box>
          </Box>
        </Box>

        {showSidebar ? (
          <SidePanel
            state={state}
            width={sidebarWidth}
            height={size.rows}
            focused={focus === 'agents'}
            onInspectAgent={inspectAgent}
            onInspectRole={inspectRole}
            onBlur={() => setFocus('composer')}
          />
        ) : null}
      </Box>
    </Box>
  );
};
