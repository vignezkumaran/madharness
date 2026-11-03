/** Conservative routing for explicit requests; ambiguous input retains the full tool loop. */
export function executionIntent(text: string): 'read' | 'write' | null {
    let value = text.trim();
    for (let index = 0; index < 3; index++)
        value = value.replace(/^(?:please|can you|could you|would you|i want you to|i need you to|help me)\s+/i, '');
    if (/^(?:clone|download|create|write|edit|fix|build|implement|run|execute|install|delete|remove|refactor|update|change|rename|move|add|test)\b/i.test(value))
        return 'write';
    if (/^(?:inspect|read|search|find|list|check)\b/i.test(value))
        return 'read';
    return null;
}
export function explanationOnly(text: string): boolean {
    return /^(?:explain|define|what (?:is|are)|tell me about)\b/i.test(text.trim()) &&
        !/\b(?:my|our|this|that|these|those|repo|repository|project|code|file|error|bug|failed|failing|detailed|comprehensive|thorough|latest|current|recent|today|news)\b|(?:\/|\\|\.(?:ts|js|py|go|rs|json)\b)/i.test(text);
}
