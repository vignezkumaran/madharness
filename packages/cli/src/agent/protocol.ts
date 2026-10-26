export interface AgentAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentReply {
  thought?: string;
  action?: AgentAction;
  done?: boolean;
  summary?: string;
}

export type ParseResult =
  | { ok: true; reply: AgentReply }
  | { ok: false; error: string; text: string };

/** Extract the first valid JSON object from model output, including fenced blocks. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fenced) {
    const parsed = tryParseObject(match[1] ?? '');
    if (parsed) return parsed;
  }

  const direct = tryParseObject(text);
  if (direct) return direct;

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const candidate = balancedObjectAt(text, start);
    if (!candidate) continue;
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normaliseArgs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    const parsed = tryParseObject(value);
    return parsed ?? {};
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Validate one worker turn. Workers must return exactly one action or done. */
export function parseAgentReply(text: string): ParseResult {
  const obj = extractJsonObject(text);

  if (!obj) {
    return {
      ok: false,
      error: 'No JSON object found. Reply with exactly one JSON object.',
      text,
    };
  }

  const thought = typeof obj.thought === 'string'
    ? obj.thought
    : typeof obj.reasoning === 'string'
      ? obj.reasoning
      : typeof obj.analysis === 'string'
        ? obj.analysis
        : undefined;

  const finalText = typeof obj.final === 'string'
    ? obj.final
    : typeof obj.answer === 'string'
      ? obj.answer
      : undefined;

  if (obj.done === true || finalText !== undefined) {
    const summary = typeof obj.summary === 'string'
      ? obj.summary
      : finalText ?? thought ?? 'Task complete.';
    return { ok: true, reply: { thought, done: true, summary } };
  }

  const rawAction = obj.action;
  let tool: string | undefined;
  let args: Record<string, unknown> = {};

  if (typeof rawAction === 'string') {
    tool = rawAction;
    args = normaliseArgs(obj.args);
  } else if (rawAction && typeof rawAction === 'object') {
    const action = rawAction as Record<string, unknown>;
    tool = typeof action.tool === 'string'
      ? action.tool
      : typeof action.name === 'string'
        ? action.name
        : undefined;
    args = normaliseArgs(action.args ?? action.input ?? action.parameters);
  } else if (typeof obj.tool === 'string') {
    tool = obj.tool;
    args = normaliseArgs(obj.args ?? obj.input ?? obj.parameters);
  }

  if (!tool) {
    return {
      ok: false,
      error: 'JSON must contain either "action": {"tool": "...", "args": {...}} or "done": true with a "summary".',
      text,
    };
  }

  return { ok: true, reply: { thought, action: { tool, args } } };
}

export function clipProtocolText(text: string, max = 1200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated]`;
}
