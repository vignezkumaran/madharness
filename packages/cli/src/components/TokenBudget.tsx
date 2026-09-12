import React from 'react';
import { Box, Text } from 'ink';
import { THEME } from '../theme.js';

interface TokenBudgetProps {
  used?: number;
  total?: number;
  providerCostPer1k?: number;
}

export const TokenBudget: React.FC<TokenBudgetProps> = ({ 
  used = 0, 
  total = 100000, 
  providerCostPer1k = 0.01 
}) => {
  const percentage = Math.min(100, Math.max(0, (used / total) * 100));
  
  let barColor = THEME.highlight;
  if (percentage > 60) barColor = THEME.primary;
  if (percentage > 85) barColor = THEME.white;

  const progressBars = Math.min(10, Math.floor(percentage / 10));
  const emptyBars = 10 - progressBars;
  const filledStr = '■'.repeat(progressBars);
  const emptyStr = '░'.repeat(emptyBars);

  const formattedUsed = used.toLocaleString();
  const formattedTotal = total.toLocaleString();
  const costEstimate = ((used / 1000) * providerCostPer1k).toFixed(3);

  return (
    <Box flexDirection="row" gap={1} alignItems="center">
      <Box>
        <Text color={barColor}>{filledStr}</Text>
        <Text color={THEME.borderDim}>{emptyStr}</Text>
      </Box>
      <Text color={barColor} bold>{percentage.toFixed(0)}%</Text>
      <Text color={THEME.borderDim}>│</Text>
      <Text color={THEME.textMuted}>{formattedUsed}/{formattedTotal}</Text>
      <Text color={THEME.borderDim}>│</Text>
      <Text color={THEME.textDim}>${costEstimate}</Text>
    </Box>
  );
};

