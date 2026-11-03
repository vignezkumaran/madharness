/** Reveal ordinary text or the summary inside the text-tool protocol as deltas arrive. */
export function assistantTextStream(emit: (text: string) => void) {
    let buffer = '';
    let sent = '';
    return (delta: string) => {
        buffer += delta;
        const trimmed = buffer.trimStart();
        if (!trimmed)
            return;
        let visible = buffer;
        if (trimmed.startsWith('{') || trimmed.startsWith('```')) {
            const summary = /"summary"\s*:\s*"/.exec(buffer);
            if (!summary)
                return; // Never display action arguments as assistant prose.
            const source = buffer.slice(summary.index + summary[0].length);
            let end = 0;
            let escaping = false;
            for (; end < source.length; end++) {
                if (escaping) {
                    escaping = false;
                    continue;
                }
                if (source[end] === '\\') {
                    escaping = true;
                    continue;
                }
                if (source[end] === '"')
                    break;
            }
            let fragment = source.slice(0, end);
            if (escaping)
                fragment = fragment.slice(0, -1);
            // A partial Unicode escape must wait for its remaining digits.
            fragment = fragment.replace(/\\u[0-9a-f]{0,3}$/i, '');
            try {
                visible = JSON.parse('"' + fragment + '"');
            }
            catch {
                return;
            }
        }
        if (visible.startsWith(sent)) {
            const next = visible.slice(sent.length);
            if (next)
                emit(next);
            sent = visible;
        }
    };
}
