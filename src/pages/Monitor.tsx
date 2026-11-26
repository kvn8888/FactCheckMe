import { useCallback, useRef, useEffect, useState } from 'react';
import { SearchCheck } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ListenButton } from '@/components/ListenButton';
import { StatusBar } from '@/components/StatusBar';
import { FactCard } from '@/components/FactCard';
import { TranscriptPanel } from '@/components/TranscriptPanel';
import { useRealtimeSTT } from '@/hooks/useRealtimeSTT';
import { useFactChecker } from '@/hooks/useFactChecker';
import { getRealtimeHealth } from '@/services/api';
import { STT_PROVIDERS, type SttProviderId } from '@/lib/stt/types';
import { toast } from 'sonner';
import type { FactCheckResult } from '@/types/factCheck';

const PROVIDER_STORAGE_KEY = 'factcheckme_stt_provider';

function readStoredProvider(): SttProviderId | null {
  try {
    const saved = localStorage.getItem(PROVIDER_STORAGE_KEY);
    return saved === 'openai-realtime' || saved === 'mai-streaming' ? saved : null;
  } catch {
    return null;
  }
}

export default function Monitor() {
  const [newResultId, setNewResultId] = useState<string | null>(null);
  const [availableProviders, setAvailableProviders] = useState<SttProviderId[]>(['openai-realtime']);
  const [provider, setProvider] = useState<SttProviderId>(() => readStoredProvider() ?? 'openai-realtime');

  const toggling = useRef(false);
  const [isToggling, setIsToggling] = useState(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  useEffect(() => {
    const controller = new AbortController();
    void getRealtimeHealth(controller.signal).then(({ providers, defaultProvider }) => {
      if (controller.signal.aborted) return;
      setAvailableProviders(providers);
      setProvider(current => (providers.includes(current) ? current : defaultProvider));
    });
    return () => controller.abort();
  }, []);

  const handleSelectProvider = useCallback((next: SttProviderId) => {
    setProvider(next);
    try { localStorage.setItem(PROVIDER_STORAGE_KEY, next); } catch { /* ignore storage errors */ }
  }, []);

  const handleNewResult = useCallback((result: FactCheckResult) => {
    setNewResultId(result.id);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setNewResultId(null), 500);
  }, []);

  const handleError = useCallback((error: string) => {
    toast.error(error);
  }, []);

  const {
    isProcessing,
    results,
    segments,
    sentenceFactChecks,
    status,
    processText,
    startMonitoring,
    stopMonitoring,
  } = useFactChecker({
    onNewResult: handleNewResult,
    onError: handleError,
  });

  const {
    isListening,
    isConnecting,
    isFinishing,
    partialTranscript,
    startListening,
    stopListening,
  } = useRealtimeSTT({
    provider,
    onTurn: text => processText(text, { source: 'turn' }),
    onStopped: () => { void stopMonitoring(); },
    onError: handleError,
  });

  const handleToggleListening = useCallback(async () => {
    if (toggling.current) return;
    toggling.current = true; setIsToggling(true);
    try {
      if (isListening) {
        await stopListening();
        toast.success('Stopped listening');

        if (isProcessing) {
          toast.info('Still processing claims in background...', {
            duration: 3000,
          });
        }
      } else {
        await startMonitoring();
        const started = await startListening();
        if (started) toast.success('Now listening for claims...');
        else await stopMonitoring();
      }
    } finally { toggling.current = false; setIsToggling(false); }
  }, [isListening, isProcessing, startListening, stopListening, startMonitoring, stopMonitoring]);

  const handleSelectFact = useCallback((result: FactCheckResult) => {
    document.getElementById(`fact-${result.id}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }, []);

  const monitorLabel = isFinishing ? 'Finishing transcription' : isConnecting
    ? 'Connecting'
    : isListening
      ? 'Live verification'
      : isProcessing
        ? 'Analyzing'
        : 'Ready';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="safe-top flex flex-wrap items-center justify-between gap-3 border-b-[4px] border-foreground bg-background px-4 py-3">
        <div>
          <p className="text-xs font-black uppercase text-primary">FactCheckMe</p>
          <h1 className="text-2xl font-black uppercase text-foreground">Audio Fact Checker</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {availableProviders.length > 1 && (
            <div
              className="flex border-[3px] border-foreground bg-card shadow-brutal-sm"
              role="radiogroup"
              aria-label="Transcription engine"
            >
              {availableProviders.map((id, index) => {
                const selected = provider === id;
                const locked = isListening || isConnecting || isFinishing || isToggling;
                const shortLabel = id === 'mai-streaming' ? 'MAI WS' : 'OpenAI';
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={locked}
                    onClick={() => handleSelectProvider(id)}
                    className={`px-2.5 py-2 text-xs font-black uppercase ${
                      index > 0 ? 'border-l-[3px] border-foreground' : ''
                    } ${
                      selected
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-card text-foreground hover:bg-muted'
                    } ${locked ? 'cursor-not-allowed opacity-60' : ''}`}
                  >
                    {shortLabel}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2 border-[3px] border-foreground bg-muted px-3 py-2 text-xs font-black uppercase shadow-brutal-sm">
            <span className={isListening ? 'text-destructive' : 'text-muted-foreground'}>
              {isListening ? '●' : '■'}
            </span>
            {monitorLabel}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="grid gap-4 lg:h-full lg:grid-cols-[minmax(0,1fr)_22rem]">
          <TranscriptPanel
            sentences={segments.map(segment => segment.text)}
            segmentIds={segments.map(segment => segment.id)}
            provisionalIds={segments.filter(segment => !segment.final).map(segment => segment.id)}
            partialTranscript={partialTranscript}
            sentenceFactChecks={sentenceFactChecks}
            isListening={isListening}
            onSelectFact={handleSelectFact}
          />

          <aside className="flex min-h-0 flex-col gap-4">
            <div className="flex flex-col items-center gap-4 border-[4px] border-foreground bg-background px-4 py-5 shadow-brutal">
              <ListenButton
                isListening={isListening}
                onToggle={handleToggleListening}
                disabled={isToggling || isConnecting || isFinishing || (!isListening && isProcessing)}
              />
              <p className="text-[11px] font-bold uppercase text-muted-foreground">
                {STT_PROVIDERS[provider].label} · {STT_PROVIDERS[provider].transport}
              </p>
            </div>

            <StatusBar status={status} />

            <section className="flex min-h-0 flex-col border-[4px] border-foreground bg-card shadow-brutal">
              <div className="flex items-center justify-between gap-3 border-b-[3px] border-foreground bg-accent px-3 py-2 text-accent-foreground">
                <div className="flex items-center gap-2">
                  <SearchCheck className="h-5 w-5" strokeWidth={3} />
                  <h2 className="text-sm font-black uppercase">Claim Evidence</h2>
                </div>
                <span className="border-[2px] border-foreground bg-card px-2 py-0.5 text-xs font-black text-foreground">
                  {results.length}
                </span>
              </div>

              {results.length === 0 ? (
                <div className="flex min-h-36 items-center justify-center p-4 text-center">
                  <p className="text-xs font-black uppercase text-muted-foreground">
                    No claims checked
                  </p>
                </div>
              ) : (
                <ScrollArea className="h-[26rem] lg:flex-1">
                  <div className="space-y-3 p-3">
                    {results.map((result) => (
                      <div key={result.id} id={`fact-${result.id}`}>
                        <FactCard
                          result={result}
                          isNew={result.id === newResultId}
                        />
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
