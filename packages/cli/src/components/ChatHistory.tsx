import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { THEME } from '../theme.js';
import type { ToolCallInfo } from '../types.js';

interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp?: number | Date;
  tokens?: number;
  latency?: number;
  provider?: string;
  model?: string;
  thought?: string;
  toolCalls?: ToolCallInfo[];
}

interface ChatHistoryProps {
  messages: Message[];
  isProcessing: boolean;
  currentProvider?: string;
}

const RelativeTime = ({ timestamp }: { timestamp: number | Date }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const timeMs = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
  const diffInMinutes = Math.floor((now - timeMs) / 60000);
  let timeStr = 'just now';
  if (diffInMinutes > 0 && diffInMinutes < 60) timeStr = `${diffInMinutes}m ago`;
  else if (diffInMinutes >= 60) timeStr = `${Math.floor(diffInMinutes / 60)}h ago`;

  return <Text color={THEME.textDim}>{timeStr}</Text>;
};

// ── Claude Code-style Code Block Formatter ────────────────────────────────────
const CodeBlock = ({ rawCode }: { rawCode: string }) => {
  const firstNewline = rawCode.indexOf('\n');
  const firstLine = firstNewline !== -1 ? rawCode.slice(0, firstNewline).trim() : '';
  const lang = firstLine.replace(/^```/, '') || 'code';
  const body = firstNewline !== -1 ? rawCode.slice(firstNewline + 1) : rawCode;
  const lines = body.split('\n');

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Code Header Bar */}
      <Box flexDirection="row" alignItems="center">
        <Text color={THEME.borderDim}>╭── </Text>
        <Text color={THEME.accent} bold>[ {lang} ]</Text>
        <Text color={THEME.borderDim}> ──────────────────────────────────────────────────────────</Text>
      </Box>

      {/* Code Body with Line Numbers */}
      <Box 
        flexDirection="column" 
        paddingLeft={1} 
        paddingRight={1}
        borderLeftColor={THEME.borderDim} 
        borderRightColor={THEME.borderDim}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
      >
        {lines.map((line, idx) => (
          <Box key={idx} flexDirection="row">
            <Box width={4} marginRight={1}>
              <Text color={THEME.textDim}>{(idx + 1).toString().padStart(3, ' ')} │</Text>
            </Box>
            <Text color={THEME.glow}>{line}</Text>
          </Box>
        ))}
      </Box>

      {/* Code Footer Bar */}
      <Box>
        <Text color={THEME.borderDim}>╰─────────────────────────────────────────────────────────────────────────</Text>
      </Box>
    </Box>
  );
};

// ── Claude-style Markdown & Content Formatter ────────────────────────────────
const FormattedContent = ({ content }: { content: string }) => {
  // Check for <thinking> block in content
  let thinkingText: string | null = null;
  let cleanContent = content;
  const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (thinkingMatch) {
    thinkingText = thinkingMatch[1]!.trim();
    cleanContent = content.replace(/<thinking>[\s\S]*?<\/thinking>/i, '').trim();
  }

  const parts = cleanContent.split(/(```[\s\S]*?```)/g);

  return (
    <Box flexDirection="column">
      {/* Claude CoT Thinking Block */}
      {thinkingText && (
        <Box 
          flexDirection="column" 
          marginY={1} 
          paddingX={1} 
          borderStyle="round" 
          borderColor={THEME.borderDim}
        >
          <Box marginBottom={0}>
            <Text color={THEME.accent} bold>🧠 Reasoning / Thought Process</Text>
          </Box>
          <Text color={THEME.textMuted} italic>{thinkingText}</Text>
        </Box>
      )}

      {parts.map((part, i) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const rawCode = part.slice(3, -3);
          return <CodeBlock key={i} rawCode={rawCode} />;
        }

        return (
          <Box key={i} flexDirection="column">
            {part.split('\n').map((line, k) => {
              if (!line.trim()) {
                return <Text key={k}> </Text>;
              }

              // H1 Heading
              if (line.startsWith('# ')) {
                return (
                  <Box key={k} marginY={1}>
                    <Text bold color={THEME.primary}>◈ {line.slice(2).trim()}</Text>
                  </Box>
                );
              }

              // H2 Heading
              if (line.startsWith('## ')) {
                return (
                  <Box key={k} marginTop={1}>
                    <Text bold color={THEME.accent}>◇ {line.slice(3).trim()}</Text>
                  </Box>
                );
              }

              // H3 Heading
              if (line.startsWith('### ')) {
                return (
                  <Box key={k} marginTop={0}>
                    <Text bold color={THEME.highlight}>◆ {line.slice(4).trim()}</Text>
                  </Box>
                );
              }

              // Bullet points
              if (line.startsWith('• ') || line.startsWith('- ') || line.startsWith('* ')) {
                const bulletText = line.replace(/^[-•*]\s*/, '');
                return (
                  <Box key={k} gap={1} marginLeft={1}>
                    <Text color={THEME.primary}>•</Text>
                    <Text color={THEME.text}>{bulletText}</Text>
                  </Box>
                );
              }

              // Numbered list
              const numMatch = line.match(/^(\d+)\.\s+(.*)/);
              if (numMatch) {
                return (
                  <Box key={k} gap={1} marginLeft={1}>
                    <Text color={THEME.accent}>{numMatch[1]}.</Text>
                    <Text color={THEME.text}>{numMatch[2]}</Text>
                  </Box>
                );
              }

              // Blockquotes
              if (line.startsWith('> ')) {
                return (
                  <Box key={k} borderLeftColor={THEME.primary} borderStyle="single" borderRight={false} borderTop={false} borderBottom={false} paddingLeft={1} marginY={0}>
                    <Text color={THEME.light} italic>{line.slice(2)}</Text>
                  </Box>
                );
              }

              // Divider
              if (line.startsWith('---') || line.startsWith('───')) {
                return (
                  <Box key={k} marginY={0}>
                    <Text color={THEME.borderSubtle}>──────────────────────────────────────────────────────────────────</Text>
                  </Box>
                );
              }

              return <Text key={k} color={THEME.text}>{line}</Text>;
            })}
          </Box>
        );
      })}
    </Box>
  );
};

// ── Claude Code Welcome Screen ────────────────────────────────────────────────
const WelcomeBanner = () => {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box 
        flexDirection="column" 
        borderStyle="round" 
        borderColor={THEME.border} 
        paddingX={2} 
        paddingY={1}
      >
        <Box justifyContent="space-between" marginBottom={1}>
          <Box gap={1} alignItems="center">
            <Text bold color={THEME.primary}>⚡ MAD HARNESS</Text>
            <Text color={THEME.borderDim}>│</Text>
            <Text bold color={THEME.white}>Claude Code Architecture</Text>
          </Box>
          <Text color={THEME.highlight}>v0.1.0 · Violet Edition</Text>
        </Box>

        <Text color={THEME.textMuted}>
          Deterministic Multi-Agent developer harness pairing AST pruning, DAG orchestration, and Jira/Git tools.
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text bold color={THEME.accent}>Quick Start & Examples:</Text>
          <Box marginLeft={1} marginTop={0} flexDirection="column">
            <Text color={THEME.text}><Text color={THEME.primary}>❯</Text> Ask questions about codebase architecture or test execution</Text>
            <Text color={THEME.text}><Text color={THEME.primary}>❯</Text> Type <Text color={THEME.highlight} bold>/dag</Text> to invoke the 4-phase deterministic pipeline</Text>
            <Text color={THEME.text}><Text color={THEME.primary}>❯</Text> Type <Text color={THEME.highlight} bold>/tools</Text> to view Jira, MCP servers, and Git tools</Text>
            <Text color={THEME.text}><Text color={THEME.primary}>❯</Text> Type <Text color={THEME.highlight} bold>/models</Text> to switch active model or connect API keys</Text>
            <Text color={THEME.text}><Text color={THEME.primary}>❯</Text> Type <Text color={THEME.highlight} bold>/help</Text> for keyboard shortcuts and command reference</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export const ChatHistory: React.FC<ChatHistoryProps> = ({ 
  messages = [], 
  isProcessing, 
  currentProvider 
}) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isProcessing) {
      setElapsed(0);
      timer = setInterval(() => setElapsed(e => e + 1), 1000);
    }
    return () => clearInterval(timer);
  }, [isProcessing]);

  // If only default welcome message or empty, display Claude Welcome Banner
  const isInitialState = !messages || messages.length === 0 || (messages.length === 1 && messages[0]?.id === 'welcome');

  return (
    <Box flexDirection="column" paddingY={0}>
      {isInitialState && <WelcomeBanner />}

      {messages && messages.filter(m => m.id !== 'welcome').map((msg, idx) => (
        <Box key={idx} flexDirection="column" marginBottom={1}>
          {/* ── User Message (Claude Code ❯ Style) ─────────────────────────── */}
          {msg.role === 'user' && (
            <Box flexDirection="column" marginY={1}>
              <Box justifyContent="space-between">
                <Box gap={1}>
                  <Text bold color={THEME.primary}>❯</Text>
                  <Text bold color={THEME.white}>You</Text>
                </Box>
                {msg.timestamp && <RelativeTime timestamp={msg.timestamp} />}
              </Box>
              <Box paddingLeft={2} marginTop={0}>
                <Text color={THEME.white} bold>{msg.content}</Text>
              </Box>
            </Box>
          )}

          {/* ── Assistant Message (Claude Code Card & Typography) ──────────── */}
          {msg.role === 'assistant' && (
            <Box flexDirection="column" marginTop={1} marginBottom={1}>
              <Box justifyContent="space-between">
                <Box gap={1} alignItems="center">
                  <Text bold color={THEME.accent}>✦</Text>
                  <Text bold color={THEME.white}>
                    {msg.provider || currentProvider || 'Claude'}
                  </Text>
                  {msg.model && (
                    <Text color={THEME.textDim}>({msg.model})</Text>
                  )}
                </Box>
                {msg.timestamp && <RelativeTime timestamp={msg.timestamp} />}
              </Box>
              
              <Box 
                paddingLeft={2} 
                paddingY={0} 
                borderLeftColor={THEME.border} 
                borderStyle="single" 
                borderRight={false} 
                borderTop={false} 
                borderBottom={false} 
                flexDirection="column"
              >
                {/* Tool Calls if any */}
                {msg.toolCalls && msg.toolCalls.map((tc, tIdx) => (
                  <Box 
                    key={tIdx} 
                    flexDirection="column" 
                    marginY={1} 
                    paddingX={1} 
                    borderStyle="round" 
                    borderColor={THEME.borderDim}
                  >
                    <Box justifyContent="space-between">
                      <Text color={THEME.highlight} bold>⚙ Tool: {tc.name}</Text>
                      <Text color={THEME.textDim}>{tc.status || 'success'}</Text>
                    </Box>
                    {tc.args && <Text color={THEME.textMuted}>{tc.args}</Text>}
                    {tc.result && <Text color={THEME.white}>{tc.result}</Text>}
                  </Box>
                ))}

                <FormattedContent content={msg.content} />

                {/* Claude-style Metadata Footer */}
                {(msg.tokens !== undefined || msg.latency !== undefined) && (
                  <Box marginTop={1} gap={2}>
                    <Text color={THEME.textDim}>
                      ⚡ {msg.tokens ? `${msg.tokens.toLocaleString()} tokens` : ''} 
                      {msg.latency ? ` · ${msg.latency}ms` : ''} 
                      {msg.model ? ` · ${msg.model}` : ''}
                    </Text>
                  </Box>
                )}
              </Box>
            </Box>
          )}

          {/* ── System Notification (Claude Code Frame) ────────────────────── */}
          {msg.role === 'system' && (
            <Box 
              marginY={1} 
              paddingX={1} 
              paddingY={0} 
              borderStyle="round" 
              borderColor={THEME.borderDim} 
              flexDirection="column"
            >
              <FormattedContent content={msg.content} />
            </Box>
          )}

          {/* ── Error Notification (Claude Inverted High-Contrast Alert) ───── */}
          {msg.role === 'error' && (
            <Box 
              marginY={1} 
              paddingX={1} 
              borderStyle="round" 
              borderColor={THEME.border} 
            >
              <Text color={THEME.white} bold>✖ </Text>
              <Text color={THEME.white}>{msg.content}</Text>
            </Box>
          )}
        </Box>
      ))}

      {/* ── Claude Code Live Thinking Spinner ─────────────────────────────── */}
      {isProcessing && (
        <Box marginTop={1} gap={1} paddingLeft={1} alignItems="center">
          <Text color={THEME.primary}><Spinner type="dots" /></Text>
          <Text color={THEME.accent} bold>Thinking with {currentProvider || 'Claude'}...</Text>
          <Text color={THEME.textDim}>({elapsed}s)</Text>
        </Box>
      )}
    </Box>
  );
};

