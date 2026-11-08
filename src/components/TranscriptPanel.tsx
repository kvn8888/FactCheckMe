import { useEffect, useRef } from 'react';
import { FileText, Loader2, Radio } from 'lucide-react';
import { normalizeSentence } from '@/lib/sentences';
import { cn } from '@/lib/utils';
import type { SentenceFactCheck } from '@/hooks/useFactChecker';
import type { FactCheckResult, Verdict } from '@/types/factCheck';

interface TranscriptPanelProps {
  sentences: string[];
  segmentIds?: string[];
  provisionalIds?: string[];
  partialTranscript: string;
  sentenceFactChecks: Record<string, SentenceFactCheck>;
  isListening: boolean;
  onSelectFact: (result: FactCheckResult) => void;
}

const verdictConfig: Record<Verdict, { label: string; className: string }> = {
  true: {
    label: 'TRUE',
    className: 'bg-verdict-true text-verdict-true-foreground',
  },
  false: {
    label: 'FALSE',
    className: 'bg-verdict-false text-verdict-false-foreground',
  },
  misleading: {
    label: 'MISLEADING',
    className: 'bg-verdict-partial text-verdict-partial-foreground',
  },
  unverifiable: {
    label: 'UNCLEAR',
    className: 'bg-verdict-unverifiable text-verdict-unverifiable-foreground',
  },
};

const legendItems = [
  ['bg-verdict-true', 'TRUE'],
  ['bg-verdict-false', 'FALSE'],
  ['bg-verdict-partial', 'MISLEADING'],
  ['bg-verdict-unverifiable', 'UNCLEAR'],
];

function TranscriptSentence({
  sentence,
  assessment,
  onSelectFact,
  provisional,
}: {
  provisional?: boolean;
  sentence: string;
  assessment: SentenceFactCheck | undefined;
  onSelectFact: (result: FactCheckResult) => void;
}) {
  if (typeof assessment === 'object' && assessment !== null) {
    const config = verdictConfig[assessment.verdict];

    return (
      <button
        type="button"
        className={cn(
          'mx-0.5 inline border-b-[3px] border-foreground px-1.5 py-0.5 text-left font-bold transition-transform hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
          config.className,
        )}
        title={`${provisional ? "Provisional, awaiting full claim. " : ""}${config.label}: ${assessment.confidence}% confidence`}
        onClick={() => onSelectFact(assessment)}
      >
        {sentence}
        <span className="ml-1 whitespace-nowrap text-[0.58rem] font-black uppercase">
          [{provisional ? `${config.label} · LIVE` : config.label}]
        </span>
      </button>
    );
  }

  if (assessment === 'pending') {
    return (
      <span className="mx-0.5 inline border-b-[3px] border-dashed border-primary bg-muted px-1.5 py-0.5 font-bold">
        {sentence}
        <Loader2 className="ml-1 inline h-3 w-3 animate-spin" strokeWidth={3} />
      </span>
    );
  }

  if (assessment === 'error') {
    return (
      <span className="mx-0.5 inline border-b-[3px] border-dotted border-destructive px-1.5 py-0.5">
        {sentence}
      </span>
    );
  }

  return <span>{sentence} </span>;
}

export function TranscriptPanel({
  sentences,
  segmentIds,
  provisionalIds = [],
  partialTranscript,
  sentenceFactChecks,
  isListening,
  onSelectFact,
}: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasTranscript = sentences.length > 0 || Boolean(partialTranscript);
  const transcriptText = sentences.join(' ');

  useEffect(() => {
    const scrollArea = scrollRef.current;
    if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
  }, [partialTranscript, transcriptText]);

  return (
    <section className="flex min-h-[22rem] flex-1 flex-col overflow-hidden border-[4px] border-foreground bg-card shadow-brutal">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-[3px] border-foreground bg-secondary px-4 py-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5" strokeWidth={3} />
          <h2 className="text-sm font-black uppercase">Live Transcript</h2>
        </div>
        <div className="flex items-center gap-2 text-xs font-black uppercase">
          <Radio className={cn('h-4 w-4', isListening && 'animate-pulse text-destructive')} strokeWidth={3} />
          {isListening ? 'Recording' : 'Paused'}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-2 border-b-[3px] border-foreground bg-background px-4 py-2">
        {legendItems.map(([color, label]) => (
          <span key={label} className="flex items-center gap-1.5 text-[0.65rem] font-black uppercase">
            <span className={cn('h-3 w-3 border-[2px] border-foreground', color)} />
            {label}
          </span>
        ))}
      </div>

      <div
        ref={scrollRef}
        className="brutal-stripes flex-1 overflow-y-auto px-5 py-5"
        role="log"
        aria-live="polite"
      >
        {hasTranscript ? (
          <p className="text-lg font-medium leading-[2.15] text-foreground">
            {sentences.map((sentence, index) => (
              <TranscriptSentence
                key={segmentIds?.[index] ?? `${index}-${sentence}`}
                sentence={sentence}
                provisional={provisionalIds.includes(segmentIds?.[index] ?? "")}
                assessment={sentenceFactChecks[segmentIds?.[index] ?? normalizeSentence(sentence)]}
                onSelectFact={onSelectFact}
              />
            ))}
            {partialTranscript && (
              <span className="border-b-[3px] border-dashed border-muted-foreground bg-muted px-1 text-muted-foreground">
                {partialTranscript}
                {isListening && <span className="ml-0.5 animate-pulse">|</span>}
              </span>
            )}
          </p>
        ) : (
          <div className="flex h-full min-h-56 items-center justify-center">
            <p className="border-[3px] border-foreground bg-muted px-4 py-3 text-sm font-black uppercase text-muted-foreground shadow-brutal-sm">
              Waiting for audio...
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
