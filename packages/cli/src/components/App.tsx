import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import * as os from 'os';
import { THEME } from '../theme.js';
import { useHarness, type TranscriptEntry } from '../hooks/useHarness.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { HarnessEntry } from './HarnessLog.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { Composer } from './Composer.js';
import { CommandPicker } from './CommandPicker.js';
import { DagProgress } from './DagProgress.js';
import { AgentPanel } from './AgentPanel.js';
function shortCwd(cwd: string): string {
    const home = os.homedir();
    const shortened = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
    if (shortened.length <= 42)
        return shortened;
    const parts = shortened.split('/');
    return `…/${parts.slice(Math.max(1, parts.length - 3)).join('/')}`;
}
const Header: React.FC<{
    cwd: string;
    branch: string;
    provider: string | null;
    columns: number;
}> = ({ cwd, branch, provider, columns }) => (<Box flexDirection="column" paddingX={1} flexShrink={0}>
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
  </Box>);
export const ActivityIndicator: React.FC<{ busy: boolean; phase: string }> = ({ busy, phase }) => {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => setFrame(value => (value + 1) % 4), 250);
        return () => clearInterval(timer);
    }, [busy]);
    return <Text>{busy ? `${['◐', '◓', '◑', '◒'][frame]} ${phase}` : '◈ ready'}</Text>;
};
export const App: React.FC<{
    initialAccess?: 'ask' | 'full';
}> = ({ initialAccess }) => {
    const { exit } = useApp();
    const { state, approval, submit, cancel, respondApproval, selectPicker, closePicker, } = useHarness(initialAccess);
    const size = useTerminalSize();
    const [scrollOffset, setScrollOffset] = useState(0);
    const previousEntries = useRef(state.entries.length);
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
            if (state.busy)
                cancel();
            else
                exit();
            return;
        }
        if (approval)
            return;
        if (state.picker)
            return;
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
        if (state.streaming === undefined)
            return null;
        return {
            id: 'streaming',
            kind: 'assistant',
            title: 'MAD',
            content: state.streaming || '_Thinking…_',
            meta: state.phase,
            at: Date.now(),
        };
    }, [state.streaming, state.phase]);
    const providerLabel = state.provider ? `${state.provider} · ${state.model}` : null;
    const scrollHint = scrollOffset > 0 ? ` · ▲ ${scrollOffset} older` : '';
    const agentViews = state.agentOrder.map(id => state.agents[id]).filter(Boolean);
    const runningAgents = agentViews.filter(agent => agent.status === 'running').length;
    return (<Box flexDirection="column" width={Math.max(1, size.columns - 1)} height={Math.max(1, size.rows - 1)} overflow="hidden">
      <Header cwd={state.cwd} branch={state.branch} provider={providerLabel} columns={Math.max(1, size.columns - 1)}/>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <Box flexDirection="row" flexGrow={1} overflow="hidden">
          <Box flexDirection="column" flexGrow={1} flexBasis={0} justifyContent="flex-end" overflowY="hidden" paddingX={1}>
            {visibleEntries.length > 0 ? visibleEntries.map((entry) => (<Box key={entry.id} flexShrink={0}>
                <HarnessEntry entry={entry}/>
              </Box>)) : (<Text color={THEME.textDim}>No output yet. Ask a question or type /help.</Text>)}
            {streamingEntry && scrollOffset === 0 ? (<Box key="streaming" flexShrink={0}>
                <HarnessEntry entry={streamingEntry}/>
              </Box>) : null}
          </Box>
          {size.columns >= 105 ? <AgentPanel agents={agentViews} log={state.agentLog}/> : null}
          </Box>

          <Box flexDirection="column" paddingX={1} flexShrink={0}>
            {state.dag&&!state.dag.finished ? (<DagProgress progress={state.dag}/>) : null}

            {state.busy ? <Box height={1}><Text color={THEME.primary} wrap="truncate-end"><ActivityIndicator busy phase={state.phase}/></Text></Box> : null}

            {approval ? (<ApprovalPrompt request={approval} onRespond={respondApproval}/>) : state.picker ? (<CommandPicker picker={state.picker} onSelect={selectPicker} onCancel={closePicker}/>) : (<Composer onSubmit={(value) => {
                setScrollOffset(0);
                void submit(value);
            }} busy={state.busy} awaitingProvider={state.awaitingProvider} awaitingKey={state.awaitingKey} provider={state.provider} history={state.history} focus={true}/>)}

            <Box height={1} width="100%" flexShrink={0}>
              <Text wrap="truncate-end" color={THEME.textDim}>
                {state.busy ? '◈ working' : '◈ ready'} · {runningAgents} agents · {state.usageEstimated && state.turnTokens ? '~' : ''}{state.turnTokens.toLocaleString()} tok this turn · {state.accessMode === 'full' ? 'FULL ACCESS' : 'ask permission'} · {approval ? 'y once / a always / n deny' : state.picker ? '↑↓ choose / Enter / Esc' : state.busy ? 'Esc cancel' : '/plan · /permissions'}{scrollHint}
              </Text>
            </Box>
          </Box>
        </Box>


      </Box>
    </Box>);
};
