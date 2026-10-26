import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EntryKind } from '../hooks/useHarness.js';
import type { ProviderName } from '../types.js';

interface Statement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint };
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

type DatabaseFactory = new (file: string) => Database;

let database: Database | null | undefined;

function db(): Database | null {
  if (database !== undefined) return database;
  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as DatabaseFactory;
    const dir = path.join(os.homedir(), '.mad');
    fs.mkdirSync(dir, { recursive: true });
    database = new Database(path.join(dir, 'sessions.db'));
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        provider TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        tokens INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dag_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        tokens INTEGER DEFAULT 0,
        changed_files TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
    `);
  } catch {
    database = null;
  }
  return database;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const sessionStore = {
  startSession(cwd: string, provider: ProviderName | null): string | null {
    const handle = db();
    if (!handle) return null;
    const id = newId();
    try {
      handle.prepare(
        'INSERT INTO sessions (id, cwd, provider, started_at) VALUES (?, ?, ?, ?)'
      ).run(id, cwd, provider, Date.now());
      return id;
    } catch {
      return null;
    }
  },

  endSession(id: string | null, tokens: number, status = 'closed'): void {
    if (!id) return;
    const handle = db();
    if (!handle) return;
    try {
      handle.prepare(
        'UPDATE sessions SET ended_at = ?, tokens = ?, status = ? WHERE id = ?'
      ).run(Date.now(), tokens, status, id);
    } catch {
      // Persistence is best effort.
    }
  },

  addMessage(sessionId: string | null, kind: EntryKind, content: string): void {
    if (!sessionId) return;
    const handle = db();
    if (!handle) return;
    try {
      handle.prepare(
        'INSERT INTO messages (session_id, kind, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(sessionId, kind, content.slice(0, 20_000), Date.now());
    } catch {
      // Persistence is best effort.
    }
  },

  startDag(sessionId: string | null, task: string): number | null {
    if (!sessionId) return null;
    const handle = db();
    if (!handle) return null;
    try {
      const result = handle.prepare(
        'INSERT INTO dag_runs (session_id, task, status, started_at) VALUES (?, ?, ?, ?)'
      ).run(sessionId, task.slice(0, 4_000), 'running', Date.now());
      return Number(result.lastInsertRowid);
    } catch {
      return null;
    }
  },

  finishDag(
    id: number | null,
    status: 'done' | 'failed' | 'cancelled',
    tokens: number,
    changedFiles: string[],
    error?: string
  ): void {
    if (id === null) return;
    const handle = db();
    if (!handle) return;
    try {
      handle.prepare(
        'UPDATE dag_runs SET status = ?, tokens = ?, changed_files = ?, error = ?, ended_at = ? WHERE id = ?'
      ).run(status, tokens, JSON.stringify(changedFiles), error ?? null, Date.now(), id);
    } catch {
      // Persistence is best effort.
    }
  },
};
