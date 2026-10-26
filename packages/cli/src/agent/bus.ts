import type { AgentRole, BusEntry, BusKind, HarnessEvent } from './types.js';

// ─── Mesh Bus ───────────────────────────────────────────────────────────────
// MAD's original idea, now wired into a real agent harness: workers do not
// re-ingest the raw workspace or each other's transcripts. They publish
// compact posts to a shared blackboard and subscribe to the latest entries.
// ─────────────────────────────────────────────────────────────────────────────

export class MeshBus {
  private entries: BusEntry[] = [];
  private limit = 240;

  constructor(private readonly emit?: (event: HarnessEvent) => void) {}

  post(agentId: string, role: AgentRole | 'user', kind: BusKind, content: string): BusEntry {
    const entry: BusEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      role,
      kind,
      content: content.trim(),
      at: Date.now(),
    };

    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries = this.entries.slice(-this.limit);
    }

    this.emit?.({ type: 'bus', entry });
    return entry;
  }

  recent(count = 8): BusEntry[] {
    return this.entries.slice(-count);
  }

  byAgent(agentId: string): BusEntry[] {
    return this.entries.filter((entry) => entry.agentId === agentId);
  }

  byKind(...kinds: BusKind[]): BusEntry[] {
    return this.entries.filter((entry) => kinds.includes(entry.kind));
  }

  snapshot(count = 10, maxChars = 900): string {
    return this.snapshotEntries(this.recent(count), maxChars);
  }

  snapshotEntries(entries: BusEntry[], maxChars = 900): string {
    if (entries.length === 0) return '(mesh bus is empty)';

    return entries
      .map((entry) => {
        const who = entry.role === 'user' ? 'user' : `${entry.role}/${entry.agentId}`;
        return `[${who} · ${entry.kind}] ${clip(entry.content, maxChars)}`;
      })
      .join('\n\n');
  }

  all(): BusEntry[] {
    return [...this.entries];
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[${text.length - max} chars clipped]`;
}
