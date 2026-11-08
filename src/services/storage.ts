import { z } from 'zod';
import type { FactCheckResult, FactCheckStats, SessionRecord, TranscriptChunk, TranscriptSegment } from '@/types/factCheck';

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
  sessionId: z.string().min(1).max(200).optional(),
  segmentId: z.string().min(1).max(200).optional(),
  revision: z.number().int().nonnegative().optional(),
});
const id = z.string().min(1).max(200);
const offset = z.number().int().nonnegative();
const chunkSchema = z.object({ id, index: offset, text: z.string(), start: offset, end: offset, receivedAt: date });
const segmentSchema = z.object({
  id, text: z.string(), start: offset, end: offset, chunkIds: z.array(id), revision: offset,
  status: z.enum(['pending', 'checked', 'no-claim', 'error']), factId: id.optional(), final: z.boolean(),
});
const sessionSchema = z.object({
  id, startedAt: date, endedAt: date.nullable(), claimsChecked: offset,
  transcript: z.string().optional(), chunks: z.array(chunkSchema).optional(), segments: z.array(segmentSchema).optional(),
}).superRefine((session, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Invalid transcript mapping' });
  if (session.transcript === undefined) {
    if (session.chunks?.length || session.segments?.length) fail();
    return;
  }
  const chunks = session.chunks ?? [];
  const segments = [...(session.segments ?? [])].sort((a, b) => a.start - b.start);
  if (new Set(chunks.map(c => c.id)).size !== chunks.length || new Set(chunks.map(c => c.index)).size !== chunks.length || new Set(segments.map(s => s.id)).size !== segments.length) fail();
  for (const item of [...chunks, ...segments]) {
    if (item.end < item.start || item.end > session.transcript.length || session.transcript.slice(item.start, item.end) !== item.text) fail();
  }
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i && segments[i - 1].end > segment.start) fail();
    if (new Set(segment.chunkIds).size !== segment.chunkIds.length || segment.chunkIds.some(chunkId => !chunks.some(c => c.id === chunkId && c.start < segment.end && c.end > segment.start))) fail();
  }
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
  // Bound whole records only. Never truncate a transcript or its segment mapping.
  const sessions = history.sessions.slice(0, MAX_SESSIONS);
  const evicted = new Set(history.sessions.slice(MAX_SESSIONS).map(s => s.id));
  const facts = history.facts.filter(f => !f.sessionId || !evicted.has(f.sessionId)).slice(0, MAX_FACTS);
  history = { ...history, facts, sessions: sessions.map(session => {
    const linked = facts.filter(f => f.sessionId === session.id);
    // Legacy records have no linkage; retain their historical count.
    return session.transcript !== undefined || linked.length || history.facts.some(f => f.sessionId === session.id)
      ? { ...session, claimsChecked: linked.filter(f => !f.segmentId || session.segments?.some(s => s.id === f.segmentId && s.final && s.status === 'checked' && s.factId === f.id && s.revision === f.revision)).length }
      : session;
  }) };
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
  save({ ...history, sessions: [session, ...history.sessions] });
  return { id: session.id, startedAt: session.startedAt.toISOString() };
}
export function localEndSession(id: string) {
  const history = load();
  save({ ...history, sessions: history.sessions.map(session => session.id === id ? { ...session, endedAt: new Date() } : session) });
}
export function localSaveFact(fact: FactCheckResult, sessionId: string | null) {
  const history = load();
  const linked = parseFact({ ...fact, sessionId: sessionId ?? fact.sessionId });
  if (!linked) { warn('An invalid fact could not be saved.'); return; }
  const session = history.sessions.find(s => s.id === linked.sessionId);
  const segment = session?.segments?.find(s => s.id === linked.segmentId);
  if (segment && linked.revision !== undefined && linked.revision < segment.revision) return;
  save({ ...history,
    facts: [linked, ...history.facts.filter(item => item.id !== linked.id && !(linked.sessionId && linked.segmentId && item.sessionId === linked.sessionId && item.segmentId === linked.segmentId))],
  });
}
export function localGetSessions() { return load().sessions; }
export function localSaveTranscript(sessionId: string, transcript: { transcript: string; chunks: TranscriptChunk[]; segments: TranscriptSegment[] }) {
  const history = load();
  const session = history.sessions.find(s => s.id === sessionId);
  if (!session) { warn('The transcript session could not be found.'); return; }
  const parsed = sessionSchema.safeParse({ ...session, ...transcript });
  if (!parsed.success) { warn('An invalid transcript mapping could not be saved.'); return; }
  save({ ...history, sessions: history.sessions.map(s => s.id === sessionId ? parsed.data as SessionRecord : s),
    facts: history.facts.filter(f => f.sessionId !== sessionId || !f.segmentId || transcript.segments.some(s => s.id === f.segmentId && s.factId === f.id && s.revision === f.revision && s.status === 'checked')),
  });
}
export function localRemoveSegmentFact(sessionId: string, segmentId: string) {
  const history = load();
  save({ ...history, facts: history.facts.filter(f => f.sessionId !== sessionId || f.segmentId !== segmentId),
    sessions: history.sessions.map(s => s.id !== sessionId ? s : { ...s, segments: s.segments?.map(segment => segment.id !== segmentId ? segment : { ...segment, factId: undefined, status: 'pending' as const }) }),
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
