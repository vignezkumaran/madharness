import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { THEME } from '../theme.js';
import type { DAGNode as SystemDAGNode } from '../types.js';

interface SimpleDAGNode {
  id?: string;
  name?: string;
  displayName?: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'halted';
  progress?: number | string;
  timing?: string;
  details?: string[];
}

interface ProgressDisplayProps {
  nodes?: SystemDAGNode[] | SimpleDAGNode[];
  dagState?: {
    nodes: SimpleDAGNode[];
  };
  isVisible?: boolean;
}

export const ProgressDisplay: React.FC<ProgressDisplayProps> = ({ nodes: propNodes, dagState, isVisible = true }) => {
  if (!isVisible) return null;

  const rawNodes = propNodes || dagState?.nodes || [
    { displayName: 'AST Intake & Pruner', status: 'passed', timing: '0.8s', details: ['Extracted signatures', '92.8% token compression'] },
    { displayName: 'Architect Agent', status: 'running', timing: '2.1s', details: ['Analyzing dependency graph'] },
    { displayName: 'Coder Agent', status: 'pending', details: [] },
    { displayName: 'Debugger & Sandbox', status: 'pending', details: [] },
  ];

  const passedCount = rawNodes.filter((n: any) => n.status === 'passed').length;

  return (
    <Box flexDirection="column" padding={1}>
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <Box marginBottom={1} justifyContent="space-between">
        <Box gap={1} alignItems="center">
          <Text bold color={THEME.primary}>⚡ Multi-Agent Pipeline (DAG)</Text>
          <Text color={THEME.borderSubtle}>│</Text>
          <Text color={THEME.highlight} bold>{passedCount} of {rawNodes.length} Phases Passed</Text>
        </Box>
        <Text color={THEME.textDim}>Deterministic Execution</Text>
      </Box>

      {/* ── Pipeline Stages ───────────────────────────────────────────────── */}
      <Box flexDirection="column" marginBottom={1}>
        {rawNodes.map((node: any, i) => {
          const isLast = i === rawNodes.length - 1;
          const name = node.displayName || node.name || node.phase || `Stage ${i + 1}`;
          const isRunning = node.status === 'running';
          const isPassed = node.status === 'passed';
          const isFailed = node.status === 'failed' || node.status === 'halted';

          let icon = <Text color={THEME.textDim}>○</Text>;
          if (isPassed) icon = <Text color={THEME.highlight} bold>✓</Text>;
          if (isFailed) icon = <Text color={THEME.white} bold>✖</Text>;
          if (isRunning) icon = <Text color={THEME.primary}><Spinner type="dots" /></Text>;

          const progressPercent = typeof node.progress === 'number' 
            ? node.progress 
            : isPassed ? 100 : isRunning ? 50 : 0;
          const progressBars = Math.floor(progressPercent / 10);
          const emptyBars = 10 - progressBars;
          const barStr = '■'.repeat(progressBars);
          const emptyStr = '░'.repeat(emptyBars);

          return (
            <Box key={node.id || node.phase || i} flexDirection="column">
              <Box 
                flexDirection="column" 
                paddingX={1} 
                paddingY={0} 
                borderStyle="round" 
                borderColor={isRunning ? THEME.border : isPassed ? THEME.borderDim : THEME.borderSubtle}
              >
                <Box justifyContent="space-between">
                  <Box gap={1} alignItems="center">
                    <Box width={2}>{icon}</Box>
                    <Text bold={isRunning} color={isPassed ? THEME.white : isRunning ? THEME.glow : THEME.textMuted}>
                      {name}
                    </Text>
                  </Box>
                  <Box gap={1} alignItems="center">
                    <Box>
                      <Text color={isPassed ? THEME.highlight : isRunning ? THEME.primary : THEME.textDim}>{barStr}</Text>
                      <Text color={THEME.borderDim}>{emptyStr}</Text>
                    </Box>
                    <Text color={isPassed ? THEME.highlight : isRunning ? THEME.primary : THEME.textDim}>
                      {node.status}
                    </Text>
                    {node.timing && <Text color={THEME.textDim}>({node.timing})</Text>}
                  </Box>
                </Box>

                {node.details && node.details.length > 0 && (
                  <Box marginTop={0} paddingLeft={3} flexDirection="column">
                    {node.details.map((det: string, dIdx: number) => (
                      <Text key={dIdx} color={THEME.textDim}>• {det}</Text>
                    ))}
                  </Box>
                )}
              </Box>

              {!isLast && (
                <Box paddingLeft={2}>
                  <Text color={THEME.borderSubtle}>│</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* ── Circuit Breaker Footer ────────────────────────────────────────── */}
      <Box 
        paddingX={1} 
        paddingY={0} 
        borderStyle="round" 
        borderColor={THEME.borderDim} 
      >
        <Text color={THEME.textMuted}>
          🛡 Circuit Breaker Policy: <Text color={THEME.accent}>Deterministic fail-fast with AST signature validation</Text>
        </Text>
      </Box>
    </Box>
  );
};

