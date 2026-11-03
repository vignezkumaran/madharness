import type { ResponseItem } from '../protocol/types.js';
function normalize(text: string): string {
    return text.trim().toLowerCase().replace(/[.!?,…]+/g, '').replace(/\s+/g, ' ').replace(/([a-z])\1+/g, '$1');
}
const greetings = new Set(['hi', 'hello', 'hey', 'hiya', 'howdy', 'hi there', 'hello there', 'hey there', 'good morning', 'good afternoon', 'good evening'].map(normalize));
const hesitation = new Set(['hmm', 'hm', 'hmmm', 'um', 'umm', 'uh', 'uhh', 'uh huh'].map(normalize));
const courtesy = new Set(['thanks', 'thank you', 'thanks a lot', 'thank you very much', 'ty', 'thx'].map(normalize));
/** Match only standalone social phrases; never swallow a task prefixed by a greeting. */
export function smallTalkReply(text: string): string | null {
    if (text.length > 100)
        return null;
    const normalized = normalize(text);
    if (greetings.has(normalized))
        return 'Hi! What would you like to work on?';
    if (hesitation.has(normalized))
        return 'Take your time. What would you like to do?';
    if (courtesy.has(normalized))
        return "You're welcome!";
    if (['how are you', 'how r u', "how's it going", 'whats up', "what's up"].map(normalize).includes(normalized))
        return "I'm ready to help. What are we working on?";
    if (normalized === normalize('who are you'))
        return "I'm MAD, your coding assistant.";
    if (normalized === normalize('what can you do'))
        return 'I can inspect code, edit files, run checks, and help with questions. Use /plan for planning or /permissions for access settings.';
    return null;
}
/** Keep local chit-chat in the transcript/rollout without charging for it on later requests. */
export function taskHistory(items: ResponseItem[]): ResponseItem[] {
    const result: ResponseItem[] = [];
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const next = items[index + 1];
        if (item.type === 'message' && item.role === 'user') {
            const reply = smallTalkReply(item.content);
            if (reply && next?.type === 'assistant-message' && next.content === reply && !next.toolCalls?.length && !next.toolRuns.length) {
                index++;
                continue;
            }
        }
        result.push(item);
    }
    return result;
}
