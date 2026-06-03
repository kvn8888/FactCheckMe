import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DEFAULT_CONFIDENCE } from './config.mjs';

const VALID_VERDICTS = new Set(['true', 'false', 'partial', 'unverifiable']);

export const parseSources = (value) => {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const toResult = (row) => ({
  id: row.id,
  claim: row.claim,
  verdict: row.verdict,
  confidence: row.confidence,
  explanation: row.explanation || undefined,
  sources: parseSources(row.sources),
  timestamp: row.created_at,
  fromCache: Boolean(row.from_cache),
});

export const normalizeFactCheckResult = (result) => {
  const numericConfidence = Number(result.confidence);
  const confidence = Number.isFinite(numericConfidence) ? numericConfidence : DEFAULT_CONFIDENCE;

  return {
    claim: result.claim,
    verdict: VALID_VERDICTS.has(result.verdict) ? result.verdict : 'unverifiable',
    confidence: Math.min(100, Math.max(0, confidence)),
    explanation: result.explanation || '',
    sources: Array.isArray(result.sources) ? result.sources : [],
  };
};

const initializeDatabase = (db) => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS fact_check_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      claims_checked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS fact_check_results (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES fact_check_sessions(id) ON DELETE CASCADE,
      claim TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('true', 'false', 'partial', 'unverifiable')),
      confidence INTEGER NOT NULL DEFAULT 75,
      explanation TEXT,
      sources TEXT NOT NULL DEFAULT '[]',
      from_cache INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fact_check_results_created_at
      ON fact_check_results(created_at DESC);
  `);
};

export function createDatabase(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') {
    const dataDir = path.dirname(dbPath);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  initializeDatabase(db);

  return {
    path: dbPath,

    createSession() {
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO fact_check_sessions (id, started_at)
        VALUES (?, ?)
      `).run(id, startedAt);
      return { id, startedAt };
    },

    endSession(sessionId) {
      db.prepare(`
        UPDATE fact_check_sessions
        SET ended_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), sessionId);
      return { ok: true };
    },

    clear() {
      db.exec('DELETE FROM fact_check_results; DELETE FROM fact_check_sessions;');
      return { ok: true };
    },

    getFacts(limit = 50) {
      const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
      const rows = db.prepare(`
        SELECT * FROM fact_check_results
        ORDER BY created_at DESC
        LIMIT ?
      `).all(safeLimit);
      return rows.map(toResult);
    },

    getStats() {
      const verdictRows = db.prepare(`
        SELECT verdict, COUNT(*) AS count
        FROM fact_check_results
        GROUP BY verdict
      `).all();
      const counts = Object.fromEntries(verdictRows.map((row) => [row.verdict, row.count]));
      const sessions = db.prepare(`
        SELECT id, started_at, ended_at, claims_checked
        FROM fact_check_sessions
        ORDER BY started_at DESC
        LIMIT 10
      `).all();

      return {
        totalChecked: Object.values(counts).reduce((sum, count) => sum + count, 0),
        trueCount: counts.true || 0,
        falseCount: counts.false || 0,
        partialCount: counts.partial || 0,
        unverifiableCount: counts.unverifiable || 0,
        sessions: sessions.map((session) => ({
          id: session.id,
          startedAt: session.started_at,
          endedAt: session.ended_at,
          claimsChecked: session.claims_checked,
        })),
      };
    },

    saveFactCheck(result, sessionId, fromCache = false) {
      const normalized = normalizeFactCheckResult(result);
      const id = randomUUID();
      const createdAt = new Date().toISOString();

      db.prepare(`
        INSERT INTO fact_check_results (
          id, session_id, claim, verdict, confidence, explanation, sources, from_cache, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        sessionId || null,
        normalized.claim,
        normalized.verdict,
        normalized.confidence,
        normalized.explanation,
        JSON.stringify(normalized.sources),
        fromCache ? 1 : 0,
        createdAt,
      );

      if (sessionId) {
        db.prepare(`
          UPDATE fact_check_sessions
          SET claims_checked = claims_checked + 1
          WHERE id = ?
        `).run(sessionId);
      }

      return {
        id,
        ...normalized,
        timestamp: createdAt,
        fromCache,
      };
    },

    close() {
      db.close();
    },
  };
}
