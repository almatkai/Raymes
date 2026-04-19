/**
 * Chat session store — sqlite-backed persistence for AI-mode conversations.
 *
 * Schema:
 *   chat_sessions(id TEXT PRIMARY KEY, title TEXT, created_at INTEGER,
 *                 updated_at INTEGER)
 *   chat_turns(id TEXT PRIMARY KEY, session_id TEXT,
 *              role TEXT, text TEXT, stages_json TEXT, error TEXT,
 *              created_at INTEGER,
 *              FOREIGN KEY(session_id) REFERENCES chat_sessions(id))
 *
 * Keeps the file tiny and dependency-light. Opens lazily on first use so
 * tests that never touch chat don't pay the migration cost.
 */

import { app } from 'electron'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Stage } from '../../shared/agent'
import type {
  ChatRole,
  ChatSession,
  ChatSessionSummary,
  ChatTurn,
} from '../../shared/chat'

type SessionRow = {
  id: string
  title: string
  created_at: number
  updated_at: number
}

type TurnRow = {
  id: string
  session_id: string
  role: string
  text: string
  stages_json: string | null
  error: string | null
  created_at: number
}

function dbPath(): string {
  const dir = join(app.getPath('userData'), 'chat')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'sessions.sqlite3')
}

function safeParseStages(value: string | null): Stage[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return undefined
    return parsed as Stage[]
  } catch {
    return undefined
  }
}

class ChatSessionDatabase {
  private readonly db: InstanceType<typeof Database>

  constructor() {
    this.db = new Database(dbPath())
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.bootstrap()
  }

  private bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        stages_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chat_turns_session ON chat_turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);
    `)
  }

  listSessions(limit = 100): ChatSessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_turns t WHERE t.session_id = s.id) AS turn_count,
                (SELECT t.text FROM chat_turns t
                   WHERE t.session_id = s.id AND t.role = 'user'
                   ORDER BY t.created_at DESC LIMIT 1) AS preview
         FROM chat_sessions s
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<
      SessionRow & { turn_count: number | bigint; preview: string | null }
    >
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      turnCount: Number(r.turn_count),
      preview: r.preview ?? '',
    }))
  }

  getSession(id: string): ChatSession | null {
    const sessionRow = this.db
      .prepare(
        `SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ?`,
      )
      .get(id) as SessionRow | undefined
    if (!sessionRow) return null
    const turnRows = this.db
      .prepare(
        `SELECT id, session_id, role, text, stages_json, error, created_at
         FROM chat_turns WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(id) as TurnRow[]
    return {
      id: sessionRow.id,
      title: sessionRow.title,
      createdAt: sessionRow.created_at,
      updatedAt: sessionRow.updated_at,
      turns: turnRows.map((t) => ({
        id: t.id,
        role: (t.role === 'assistant' ? 'assistant' : 'user') as ChatRole,
        text: t.text,
        stages: safeParseStages(t.stages_json),
        error: t.error ?? undefined,
        createdAt: t.created_at,
      })),
    }
  }

  upsertSession(
    session: Pick<ChatSession, 'id' | 'title' | 'createdAt' | 'updatedAt'>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO chat_sessions(id, title, created_at, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           updated_at = excluded.updated_at`,
      )
      .run(session.id, session.title, session.createdAt, session.updatedAt)
  }

  appendTurn(sessionId: string, turn: ChatTurn): void {
    this.db
      .prepare(
        `INSERT INTO chat_turns(id, session_id, role, text, stages_json, error, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           stages_json = excluded.stages_json,
           error = excluded.error`,
      )
      .run(
        turn.id,
        sessionId,
        turn.role,
        turn.text,
        turn.stages ? JSON.stringify(turn.stages) : null,
        turn.error ?? null,
        turn.createdAt,
      )
    this.db
      .prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`)
      .run(Math.max(turn.createdAt, Date.now()), sessionId)
  }

  updateTitle(sessionId: string, title: string): void {
    this.db
      .prepare(`UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, Date.now(), sessionId)
  }

  deleteSession(id: string): boolean {
    const info = this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id)
    return info.changes > 0
  }

  clearAll(): void {
    this.db.exec(`DELETE FROM chat_turns; DELETE FROM chat_sessions;`)
  }
}

let instance: ChatSessionDatabase | null = null

function store(): ChatSessionDatabase {
  if (!instance) instance = new ChatSessionDatabase()
  return instance
}

export function listChatSessions(limit?: number): ChatSessionSummary[] {
  return store().listSessions(limit)
}

export function getChatSession(id: string): ChatSession | null {
  return store().getSession(id)
}

export function upsertChatSession(
  session: Pick<ChatSession, 'id' | 'title' | 'createdAt' | 'updatedAt'>,
): void {
  store().upsertSession(session)
}

export function appendChatTurn(sessionId: string, turn: ChatTurn): void {
  store().appendTurn(sessionId, turn)
}

export function updateChatSessionTitle(sessionId: string, title: string): void {
  store().updateTitle(sessionId, title)
}

export function deleteChatSession(id: string): boolean {
  return store().deleteSession(id)
}

export function clearAllChatSessions(): void {
  store().clearAll()
}
