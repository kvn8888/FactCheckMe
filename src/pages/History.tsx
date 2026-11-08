import { useState } from 'react';
import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FactCard } from '@/components/FactCard';
import { VerdictBadge } from '@/components/VerdictBadge';
import { localGetFacts, localGetSessions } from '@/services/storage';
import type { FactCheckResult, SessionRecord, Verdict } from '@/types/factCheck';

const filters: (Verdict | 'all')[] = ['all', 'true', 'false', 'misleading', 'unverifiable'];

function SessionHistory({ session, facts }: { session: SessionRecord; facts: FactCheckResult[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const segment = session.segments?.find(s => s.id === selected);
  const fact = facts.find(f => f.id === segment?.factId);
  const transcript: ReactNode[] = [];
  let cursor = 0;
  for (const item of [...(session.segments ?? [])].sort((a, b) => a.start - b.start)) {
    transcript.push(session.transcript?.slice(cursor, item.start));
    transcript.push(<button key={item.id} type="button" aria-pressed={selected === item.id}
      aria-label={`Segment ${item.start + 1}: ${item.text}`}
      className={`text-left rounded px-0.5 underline decoration-dotted ${selected === item.id ? 'bg-primary text-primary-foreground' : item.factId ? 'bg-accent' : 'bg-muted'}`}
      onClick={() => setSelected(item.id)}>{item.text}</button>);
    cursor = item.end;
  }
  transcript.push(session.transcript?.slice(cursor));
  return <article className="border-[3px] border-foreground p-4 space-y-4 bg-card">
    <h2 className="font-black">Session · {session.startedAt.toLocaleString()}</h2>
    <p className="text-sm">{session.claimsChecked} checked claims · {session.endedAt ? 'Ended' : 'Open session'}</p>
    {session.transcript !== undefined ? <>
      <h3 className="font-bold">Full transcript</h3>
      <p className="whitespace-pre-wrap leading-8 break-words">{session.transcript ? transcript : 'No transcript text recorded.'}</p>
      {!!session.segments?.length && <p className="text-xs text-muted-foreground">Select a transcript segment to see its result and original chunks.</p>}
      {segment && <section aria-label="Selected segment evidence" className="border-2 border-primary p-3 space-y-3">
        <p className="font-bold">Segment · {segment.status}{!segment.final ? ' · provisional' : ''} · revision {segment.revision}</p>
        {fact ? <>
          <VerdictBadge verdict={fact.verdict} />
          <p>{fact.explanation || 'No explanation was returned.'}</p>
          {fact.sources.map((source, index) => <a key={index} href={source.url} target="_blank" rel="noopener noreferrer" className="block underline">{source.title || source.domain}</a>)}
        </> : <p>{segment.status === 'no-claim' ? 'No checkable claim detected in this segment.' : segment.status === 'checked' ? 'This result is no longer retained in history.' : segment.status === 'pending' && session.endedAt ? 'This session ended before this segment was checked.' : segment.status === 'error' ? 'This segment could not be checked.' : 'No completed result for this segment.'}</p>}
        <p className="text-xs">Characters {segment.start}–{segment.end} · Chunks: {segment.chunkIds.map(id => (session.chunks?.find(c => c.id === id)?.index ?? -1) + 1).join(', ') || 'none'}</p>
      </section>}
      <details><summary className="cursor-pointer font-bold">Original transcript chunks ({session.chunks?.length ?? 0})</summary>
        <ol className="space-y-2 mt-2">{session.chunks?.map(chunk => <li key={chunk.id} className={`p-2 border whitespace-pre-wrap ${segment?.chunkIds.includes(chunk.id) ? 'border-primary bg-accent' : ''}`}>
          <span className="block text-xs">Chunk {chunk.index + 1} · {chunk.receivedAt.toLocaleTimeString()} · characters {chunk.start}–{chunk.end}</span>{chunk.text}
        </li>)}</ol>
      </details>
    </> : <p className="text-muted-foreground">Older session: a full transcript was not saved.</p>}
    {!!facts.length && <details><summary className="cursor-pointer font-bold">Checked claims ({facts.length})</summary><div className="space-y-3 mt-3">{facts.map(f => <FactCard key={f.id} result={f} />)}</div></details>}
  </article>;
}

export default function History() {
  const [data, setData] = useState(() => ({ sessions: localGetSessions(), facts: localGetFacts(500) }));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Verdict | 'all'>('all');
  const search = query.trim().toLowerCase();
  const verdictMatches = (f: FactCheckResult) => filter === 'all' || f.verdict === filter;
  const sessions = data.sessions.filter(session => {
    const facts = data.facts.filter(f => f.sessionId === session.id);
    return (filter === 'all' || facts.some(verdictMatches)) && (!search || session.transcript?.toLowerCase().includes(search) || facts.some(f => f.claim.toLowerCase().includes(search)));
  });
  const legacy = data.facts.filter(f => (!f.sessionId || !data.sessions.some(s => s.id === f.sessionId)) && verdictMatches(f) && f.claim.toLowerCase().includes(search));
  return <div className="flex flex-col h-full">
    <header className="px-4 py-4 space-y-4 safe-top">
      <div className="flex justify-between items-center"><h1 className="text-2xl font-black">📜 HISTORY</h1>
        <Button variant="outline" size="icon" aria-label="Refresh history" onClick={() => setData({ sessions: localGetSessions(), facts: localGetFacts(500) })}><RefreshCw className="h-5 w-5" /></Button>
      </div>
      <p className="text-sm text-muted-foreground">Saved in this browser only. Full transcripts and chunk mappings are retained; raw audio is not. Up to 100 sessions and 500 results are kept.</p>
      <Input aria-label="Search transcripts and claims" placeholder="SEARCH TRANSCRIPTS AND CLAIMS..." value={query} onChange={event => setQuery(event.target.value)} />
      <div className="flex gap-2 overflow-x-auto pb-2">{filters.map(value => <Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'ALL' : <VerdictBadge verdict={value} size="sm" />}</Button>)}</div>
    </header>
    <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-24 space-y-4">
      {!sessions.length && !legacy.length && <p className="p-6 text-center font-bold">{search || filter !== 'all' ? 'NO RESULTS MATCH YOUR FILTERS' : 'NO FACT-CHECK HISTORY YET'}</p>}
      {sessions.map(session => <SessionHistory key={session.id} session={session} facts={data.facts.filter(f => f.sessionId === session.id)} />)}
      {!!legacy.length && <section className="space-y-3"><h2 className="font-bold">Earlier claims without transcript mapping</h2>{legacy.map(f => <FactCard key={f.id} result={f} />)}</section>}
    </div>
  </div>;
}
