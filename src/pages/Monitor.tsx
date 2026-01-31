import { useState, useCallback } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ListenButton } from '@/components/ListenButton';
import { StatusBar } from '@/components/StatusBar';
import { FactCard } from '@/components/FactCard';
import { useElevenLabsSTT } from '@/hooks/useElevenLabsSTT';
import { useFactChecker } from '@/hooks/useFactChecker';
import { toast } from 'sonner';
import type { FactCheckResult } from '@/types/factCheck';

export default function Monitor() {
  const [newResultId, setNewResultId] = useState<string | null>(null);

  const handleNewResult = useCallback((result: FactCheckResult) => {
    setNewResultId(result.id);
    setTimeout(() => setNewResultId(null), 500);
  }, []);

  const handleError = useCallback((error: string) => {
    toast.error(error);
  }, []);

  const {
    isProcessing,
    results,
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
    startListening,
    stopListening,
    partialTranscript,
  } = useElevenLabsSTT({
    onTranscript: processText,
    onError: handleError,
  });

  const handleToggleListening = useCallback(async () => {
    if (isListening) {
      // Stop listening first (immediate)
      stopListening();
      toast.success('Stopped listening');

      // Stop monitoring in background (processing continues)
      stopMonitoring();

      if (isProcessing) {
        toast.info('Still processing claims in background...', {
          duration: 3000,
        });
      }
    } else {
      // Start monitoring session
      await startMonitoring();

      // Start listening
      const started = await startListening();
      if (started) {
        toast.success('Now listening for claims...');
      }
    }
  }, [isListening, isProcessing, startListening, stopListening, startMonitoring, stopMonitoring]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="px-4 py-6 text-center space-y-2 safe-top">
        <h1 className="text-3xl font-black uppercase tracking-tight text-foreground">
          AUDIO FACT CHECKER
        </h1>
        <div className="inline-block px-4 py-1 bg-muted border-[3px] border-foreground shadow-brutal-sm">
          <p className="text-sm font-bold uppercase text-muted-foreground">
            {isConnecting
              ? '⏳ CONNECTING...'
              : isProcessing
                ? '🔍 ANALYZING...'
                : isListening
                  ? '📡 REAL-TIME VERIFICATION'
                  : '⏸️ READY'}
          </p>
        </div>
      </header>

      {/* Listen Button */}
      <div className="flex justify-center py-6">
        <ListenButton 
          isListening={isListening} 
          onToggle={handleToggleListening}
          disabled={isConnecting}
        />
      </div>

      {/* Live Transcript Preview */}
      {isListening && partialTranscript && (
        <div className="px-4 mb-4">
          <div className="bg-secondary border-[3px] border-foreground shadow-brutal p-4">
            <p className="text-xs font-black uppercase tracking-wide mb-2 text-secondary-foreground">
              👂 HEARING...
            </p>
            <p className="text-base font-bold text-secondary-foreground">
              "{partialTranscript}"
            </p>
          </div>
        </div>
      )}

      {/* Status Bar */}
      <div className="px-4 mb-4">
        <StatusBar status={status} />
        {!isListening && isProcessing && (
          <div className="mt-2 px-3 py-2 bg-yellow-100 dark:bg-yellow-900/30 border-[2px] border-yellow-500 rounded">
            <p className="text-xs font-bold text-yellow-800 dark:text-yellow-200 flex items-center gap-2">
              <span className="animate-pulse">⚡</span>
              Processing claims in background...
            </p>
          </div>
        )}
      </div>

      {/* Results Feed */}
      <div className="flex-1 min-h-0 px-4 pb-24">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-black uppercase tracking-wide text-foreground">
            📋 Recent Results
          </h2>
          {results.length > 0 && (
            <span className="text-sm font-bold px-3 py-1 bg-primary text-primary-foreground border-[2px] border-foreground">
              {results.length}
            </span>
          )}
        </div>

        {results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="p-6 bg-muted border-[3px] border-foreground shadow-brutal">
              <p className="font-bold text-muted-foreground uppercase">
                {isListening
                  ? '🎧 LISTENING FOR CLAIMS...'
                  : '👆 TAP THE MICROPHONE TO START'}
              </p>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-[calc(100vh-520px)]">
            <div className="space-y-3 pb-4">
              {results.map((result) => (
                <FactCard
                  key={result.id}
                  result={result}
                  isNew={result.id === newResultId}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
