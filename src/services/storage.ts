import { z } from 'zod';
import type { FactCheckResult, FactCheckStats, SessionRecord } from '@/types/factCheck';

export const STORAGE_KEY = 'factcheckme.history.v1';
export const STORAGE_WARNING_EVENT = 'factcheckme:storage-warning';
const MAX_FACTS = 500;
const MAX_SESSIONS = 100;
const date = z.union([z.string(), z.date()]).transform(value => new Date(value)).refine(value => !Number.isNaN(value.getTime()));
const sourceSchema = z.object({
  title: z.string().max(2000),
  url: z.string().max(4000).refine(value => /^https?:\/\//i.test(value)),
  domain: z.string().max(1000),
});
const factSchema = z.object({
  id: z.string().min(1).max(200),
  claim: z.string().max(20000),
  verdict: z.enum(['true', 'false', 'misleading', 'partial', 'unverifiable']).transform(value => value === 'partial' ? 'misleading' as const : value),
  confidence: z.number().finite().min(0).max(100),
  timestamp: date,
  sources: z.array(sourceSchema).max(30),
  explanation: z.string().max(30000).optional(),
  fromCache: z.boolean().optional(),
});
const sessionSchema = z.object({
  id: z.string().min(1).max(200), startedAt: date, endedAt: date.nullable(),
  claimsChecked: z.number().int().nonnegative(),
});
interface History { version: 1; facts: FactCheckResult[]; sessions: SessionRecord[] }
let memory: History = { version: 1, facts: [], sessions: [] };
let memoryOnly = false;
let warning = '';
function warn(message: string) {
  warning = message;
  window.dispatchEvent(new Event(STORAGE_WARNING_EVENT));
}
export const getStorageWarning = () => warning;
export function parseFact(value: unknown): FactCheckResult | null {
  const result = factSchema.safeParse(value);
  return result.success ? result.data as FactCheckResult : null;
}
function load(): History {
  if (memoryOnly) return memory;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return memory = { version: 1, facts: [], sessions: [] };
    if (raw.length > 20_000_000) throw new Error('Oversized history');
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.facts) || !Array.isArray(value.sessions)) throw new Error('Invalid history');
    const facts = value.facts.slice(0, MAX_FACTS).map(parseFact).filter((item: FactCheckResult | null): item is FactCheckResult => item !== null);
    const sessions = value.sessions.slice(0, MAX_SESSIONS).flatMap((item: unknown) => {
      const parsed = sessionSchema.safeParse(item);
      return parsed.success ? [parsed.data as SessionRecord] : [];
    });
    if (facts.length !== Math.min(value.facts.length, MAX_FACTS) || sessions.length !== Math.min(value.sessions.length, MAX_SESSIONS)) warn('Some invalid saved history was ignored.');
    return memory = { version: 1, facts, sessions };
  } catch {
    memoryOnly = true;
    warn('Saved history could not be read. New history will remain in this tab only.');
    return memory;
  }
}
function save(history: History) {
  memory = history;
  if (memoryOnly) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); }
  catch {
    memoryOnly = true;
    warn('Browser storage is unavailable or full. New history will remain in this tab only.');
  }
}
export function localCreateSession() {
  const history = load();
  const session: SessionRecord = { id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-'), startedAt: new Date(), endedAt: null, claimsChecked: 0 };
  save({ ...history, sessions: [session, ...history.sessions].slice(0, MAX_SESSIONS) });
  return { id: session.id, startedAt: session.startedAt.toISOString() };
}
export function localEndSession(id: string) {
  const history = load();
  save({ ...history, sessions: history.sessions.map(session => session.id === id ? { ...session, endedAt: new Date() } : session) });
}
export function localSaveFact(fact: FactCheckResult, sessionId: string | null) {
  const history = load();
  const duplicate = history.facts.some(item => item.id === fact.id);
  save({ ...history,
    facts: [fact, ...history.facts.filter(item => item.id !== fact.id)].slice(0, MAX_FACTS),
    sessions: history.sessions.map(session => session.id === sessionId && !duplicate ? { ...session, claimsChecked: session.claimsChecked + 1 } : session),
  });
}
export function localGetFacts(limit = 50) { return load().facts.slice(0, Math.max(0, Math.min(MAX_FACTS, limit))); }
export function localGetStats(): FactCheckStats {
  const { facts, sessions } = load();
  return {
    totalChecked: facts.length,
    trueCount: facts.filter(f => f.verdict === 'true').length,
    falseCount: facts.filter(f => f.verdict === 'false').length,
    misleadingCount: facts.filter(f => f.verdict === 'misleading').length,
    unverifiableCount: facts.filter(f => f.verdict === 'unverifiable').length,
    sessions,
  };
}
export function localClear() {
  memory = { version: 1, facts: [], sessions: [] };
  // Try removing persisted data even after a write/quota failure.
  try { localStorage.removeItem(STORAGE_KEY); memoryOnly = false; warning = ''; }
  catch { memoryOnly = true; warn('This tab was cleared, but saved browser history could not be removed. Clear it in browser settings.'); throw new Error('Saved browser history could not be removed'); }
  window.dispatchEvent(new Event(STORAGE_WARNING_EVENT));
}
