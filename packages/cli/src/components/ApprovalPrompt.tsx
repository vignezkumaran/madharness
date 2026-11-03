import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { THEME } from '../theme.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type { ReviewDecision } from '../protocol/types.js';
import type { ApprovalView } from '../hooks/useHarness.js';
interface Props {
    request: ApprovalView;
    onRespond: (decision: ReviewDecision) => void;
}
export const ApprovalPrompt: React.FC<Props> = ({ request, onRespond }) => {
    const { rows, columns } = useTerminalSize();
    const width = Math.max(12, columns - 10);
    const pageSize = Math.max(2, Math.min(8, rows - 12));
    const [offset, setOffset] = useState(0);
    const lines = useMemo(() => request.brief.split('\n').flatMap(line => {
        if (!line.length)
            return [' '];
        const chunks: string[] = [];
        for (let index = 0; index < line.length; index += width)
            chunks.push(line.slice(index, index + width));
        return chunks;
    }), [request.brief, width]);
    const maxOffset = Math.max(0, lines.length - pageSize);
    useEffect(() => setOffset(0), [request.id]);
    useInput((input, key) => {
        if (key.upArrow || key.pageUp)
            setOffset(value => Math.max(0, value - (key.pageUp ? pageSize : 1)));
        else if (key.downArrow || key.pageDown)
            setOffset(value => Math.min(maxOffset, value + (key.pageDown ? pageSize : 1)));
        else if (input.toLowerCase() === 'y')
            onRespond('approved-once');
        else if (input.toLowerCase() === 'a')
            onRespond('approved-always');
        else if (input.toLowerCase() === 'n' || key.escape)
            onRespond('denied');
    });
    return <Box flexDirection="column" borderStyle="round" borderColor={THEME.highlight} paddingX={1} flexShrink={0}>
        <Text color={THEME.highlight} bold wrap="truncate-end">Permission required · {request.tool}</Text>
        {lines.slice(offset, offset + pageSize).map((line, index) => <Text key={offset + index} wrap="truncate-end" color={THEME.white}>{line}</Text>)}
        {lines.length > pageSize ? <Text dimColor>Lines {offset + 1}–{Math.min(lines.length, offset + pageSize)}/{lines.length} · ↑↓ or PgUp/PgDn to inspect</Text> : null}
        <Text wrap="truncate-end" color={THEME.highlight}>y allow once · a always this action · n/Esc deny</Text>
    </Box>;
};
