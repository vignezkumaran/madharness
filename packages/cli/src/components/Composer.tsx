import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { THEME } from '../theme.js';
import type { ProviderName } from '../providers/manager.js';
interface ComposerProps {
    onSubmit: (value: string) => void;
    busy: boolean;
    awaitingProvider: ProviderName | null;
    awaitingKey: boolean;
    provider: ProviderName | null;
    history: string[];
    focus: boolean;
}
interface CommandHint {
    cmd: string;
    desc: string;
    arg?: boolean;
}
/** A fixed-height input viewport keeps long prompts from resizing the terminal frame. */
const StableInput: React.FC<{ value: string; onChange: (value: string) => void; onSubmit: (value: string) => void; focus: boolean; mask?: string; placeholder: string }> = ({ value, onChange, onSubmit, focus, mask, placeholder }) => {
    const { stdout } = useStdout();
    const [cursor, setCursor] = useState(value.length);
    const expectedValue = useRef(value);
    useEffect(() => {
        if (expectedValue.current !== value) setCursor(value.length);
        expectedValue.current = value;
    }, [value]);
    useInput((input, key) => {
        if (key.return) { onSubmit(value); setCursor(value.length); return; }
        if (key.upArrow || key.downArrow || key.tab || key.escape || key.ctrl || key.meta) return;
        if (key.leftArrow) { setCursor(offset => offset - (Array.from(value.slice(0, offset)).pop()?.length ?? 0)); return; }
        if (key.rightArrow) { setCursor(offset => offset + (Array.from(value.slice(offset))[0]?.length ?? 0)); return; }
        if (key.backspace || key.delete) {
            const previous = Array.from(value.slice(0, cursor)).pop()?.length ?? 0;
            if (previous) { const next = value.slice(0, cursor - previous) + value.slice(cursor); expectedValue.current = next; onChange(next); setCursor(cursor - previous); }
            return;
        }
        if (input) {
            const text = input.replace(/[\r\n\t]/g, ' ');
            const next = value.slice(0, cursor) + text + value.slice(cursor);
            expectedValue.current = next;
            onChange(next);
            setCursor(cursor + text.length);
        }
    }, { isActive: focus });
    const shown = mask ? mask.repeat(value.length) : value;
    const width = Math.max(4, (stdout.columns || 80) - 24);
    // Non-ASCII characters may occupy two terminal cells; use a conservative window.
    const windowSize = /[^\x00-\x7f]/.test(shown) ? Math.max(2, Math.floor(width / 2)) : width;
    let start = Math.max(0, cursor - windowSize + 1);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(shown[start])) start--;
    const visible = shown.slice(start, start + windowSize);
    const at = Math.min(cursor - start, visible.length);
    const cursorChar = Array.from(visible.slice(at))[0] ?? ' ';
    return <Text wrap="truncate-end">{shown ? <>{visible.slice(0, at)}<Text inverse>{cursorChar}</Text>{visible.slice(at + cursorChar.length)}</> : <Text color={THEME.textDim}>{placeholder.slice(0, windowSize)}</Text>}</Text>;
};
const COMMANDS: CommandHint[] = [
    { cmd: '/help', desc: 'Show commands and keys' },
    { cmd: '/run', desc: 'Execute the prepared plan (or a task directly)', arg: true },
    { cmd: '/plan', desc: 'Plan a task without executing it', arg: true },
    { cmd: '/agent', desc: 'Create a named agent', arg: true },
    { cmd: '/task', desc: 'Assign a task to a named agent', arg: true },
    { cmd: '/resume', desc: 'List or resume a saved session', arg: true },
    { cmd: '/agents', desc: 'Browse worker status and roles' },
    { cmd: '/diff', desc: 'Show working tree diff' },
    { cmd: '/status', desc: 'Session and provider status' },
    { cmd: '/modelprovider', desc: 'Choose a model provider' },
    {cmd:'/ollama',desc:'Connect to Ollama or choose an installed model',arg:true},
    { cmd: '/models', desc: 'Choose a model' },
    { cmd: '/model', desc: 'Switch provider or model', arg: true },
    { cmd: '/login', desc: 'Connect a provider key (auto-detects)', arg: true },
    { cmd: '/logout', desc: 'Remove a provider key', arg: true },
    { cmd: '/distill', desc: 'Distill a file contract', arg: true },
    { cmd: '/cwd', desc: 'Show or change workspace', arg: true },
    { cmd: '/permissions', desc: 'Choose ask permission or full access' },
    { cmd: '/clear', desc: 'Clear screen and transcript' },
    { cmd: '/cancel', desc: 'Stop the running chat or DAG' },
    { cmd: '/exit', desc: 'Quit MAD' },
];
export const Composer: React.FC<ComposerProps> = ({ onSubmit, busy, awaitingProvider, awaitingKey, provider, history, focus, }) => {
    const [value, setValue] = useState('');
    const [selected, setSelected] = useState(0);
    const [histIndex, setHistIndex] = useState(-1);
    const awaitingSecret = Boolean(awaitingProvider) || awaitingKey;
    const showSuggestions = !awaitingSecret && value.startsWith('/') && !value.includes(' ');
    const matching = showSuggestions
        ? COMMANDS.filter((command) => command.cmd.startsWith(value.toLowerCase())).slice(0, 6)
        : [];
    useEffect(() => {
        setSelected(0);
    }, [value]);
    useInput((input, key) => {
        if (!focus || awaitingSecret)
            return;
        if (showSuggestions && matching.length > 0) {
            if (key.upArrow) {
                setSelected((current) => (current - 1 + matching.length) % matching.length);
                return;
            }
            if (key.downArrow) {
                setSelected((current) => (current + 1) % matching.length);
                return;
            }
            if (key.tab) {
                const command = matching[selected];
                if (command)
                    setValue(command.arg ? `${command.cmd} ` : command.cmd);
                return;
            }
        }
        if (key.tab && !awaitingSecret) {
            return;
        }
        if (!showSuggestions && history.length > 0) {
            if (key.upArrow) {
                const next = histIndex === -1 ? history.length - 1 : Math.max(0, histIndex - 1);
                setHistIndex(next);
                setValue(history[next] ?? '');
                return;
            }
            if (key.downArrow) {
                if (histIndex === -1)
                    return;
                const next = histIndex + 1;
                if (next >= history.length) {
                    setHistIndex(-1);
                    setValue('');
                }
                else {
                    setHistIndex(next);
                    setValue(history[next] ?? '');
                }
                return;
            }
        }
    }, { isActive: focus && !awaitingSecret });
    const submit = (raw: string) => {
        const text = raw.trim();
        if (!text)
            return;
        if (showSuggestions && matching.length > 0 && !matching.some((command) => command.cmd === text)) {
            const command = matching[selected];
            if (command) {
                setValue(command.arg ? `${command.cmd} ` : command.cmd);
                return;
            }
        }
        setValue('');
        setHistIndex(-1);
        onSubmit(text);
    };
    return (<Box flexDirection="column">
      {showSuggestions ? (<Box flexDirection="column" borderStyle="round" borderColor={THEME.borderSubtle} paddingX={1} marginBottom={0}>
          {matching.length > 0 ? matching.map((command, index) => (<Box key={command.cmd} gap={2}>
              <Text color={index === selected ? THEME.primary : THEME.textDim}>
                {index === selected ? '▸ ' : '  '}
                <Text color={index === selected ? THEME.white : THEME.textMuted} bold={index === selected}>
                  {command.cmd}
                </Text>
              </Text>
              <Text color={THEME.textDim}>{command.desc}</Text>
            </Box>)) : (<Text color={THEME.textDim}>No matching command. Press /help.</Text>)}
          <Text color={THEME.textDim}>Tab complete · ↑↓ select · Enter run</Text>
        </Box>) : null}

      <Box flexDirection="column" borderStyle="round" borderColor={awaitingSecret ? THEME.highlight : focus ? THEME.border : THEME.borderSubtle} paddingX={1}>
        <Box alignItems="center">
          {awaitingSecret ? (<Box marginRight={1} gap={1}>
              <Text color={THEME.highlight} bold>🔑 [{awaitingProvider ?? 'auto'}]</Text>
              <Text color={THEME.primary} bold>❯</Text>
            </Box>) : (<Box marginRight={1} gap={1}>
              <Text color={THEME.accent} bold>[{provider ?? 'offline'}]</Text>
              <Text color={THEME.primary} bold>❯</Text>
            </Box>)}
          <Box flexGrow={1} flexBasis={0} height={1} overflow="hidden">
            <StableInput value={value} onChange={(next) => {
            setValue(next);
            setHistIndex(-1);
        }} onSubmit={submit} mask={awaitingSecret ? '*' : undefined} focus={focus} placeholder={awaitingProvider
            ? `Paste API key for ${awaitingProvider}`
            : awaitingKey
                ? 'Paste any provider API key (auto-detects provider)'
                : 'Describe a task, ask a question, or type / for commands'}/>
          </Box>
        </Box>
      </Box>
    </Box>);
};
