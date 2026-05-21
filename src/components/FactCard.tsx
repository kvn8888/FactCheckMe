import { useState } from 'react';
import { ChevronDown, ExternalLink, Clock, Loader2, Volume2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { VerdictBadge } from '@/components/VerdictBadge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { synthesizeSpeech } from '@/services/api';
import type { FactCheckResult } from '@/types/factCheck';

interface FactCardProps {
  result: FactCheckResult;
  className?: string;
  isNew?: boolean;
}

export function FactCard({ result, className, isNew = false }: FactCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);

  const formatTime = (date: Date) => {
    return new Date(date).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const getSpeechText = () => {
    const sourceSummary = result.sources.length > 0
      ? `Sources include ${result.sources.slice(0, 2).map((source) => source.domain || source.title).join(' and ')}.`
      : 'No source URLs were returned.';

    return [
      `Claim: ${result.claim}.`,
      `Verdict: ${result.verdict}.`,
      `Confidence: ${result.confidence} percent.`,
      result.explanation ? `Explanation: ${result.explanation}` : '',
      sourceSummary,
    ].filter(Boolean).join(' ');
  };

  const playSpeech = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setIsSpeaking(true);
    setSpeechError(null);

    try {
      const response = await synthesizeSpeech(getSpeechText());
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to generate speech');
      }

      const binary = atob(response.data.audioData);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: response.data.mimeType });
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);

      audio.addEventListener('ended', () => URL.revokeObjectURL(audioUrl), { once: true });
      audio.addEventListener('error', () => URL.revokeObjectURL(audioUrl), { once: true });
      await audio.play();
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : 'Failed to play speech');
    } finally {
      setIsSpeaking(false);
    }
  };

  return (
    <Card
      className={cn(
        'cursor-pointer transition-all duration-150',
        'hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-brutal-lg',
        'active:translate-x-[2px] active:translate-y-[2px] active:shadow-none',
        isNew && 'card-enter',
        className
      )}
      onClick={() => setIsExpanded(!isExpanded)}
    >
      <CardContent className="p-4">
        {/* Main content row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-foreground leading-relaxed line-clamp-2">
              "{result.claim}"
            </p>
          </div>
          <div 
            className={cn(
              'h-8 w-8 flex items-center justify-center border-[2px] border-foreground bg-muted shrink-0 transition-transform duration-150',
              isExpanded && 'rotate-180'
            )}
          >
            <ChevronDown className="h-5 w-5" strokeWidth={3} />
          </div>
        </div>

        {/* Verdict and timestamp row */}
        <div className="flex items-center justify-between mt-3">
          <VerdictBadge verdict={result.verdict} size="sm" />
          <div className="flex items-center gap-1.5 text-sm font-bold text-muted-foreground bg-muted px-2 py-1 border-[2px] border-foreground">
            <Clock className="h-3 w-3" strokeWidth={3} />
            <span>{formatTime(result.timestamp)}</span>
          </div>
        </div>

        {/* Expanded content */}
        {isExpanded && (
          <div className="mt-4 pt-4 border-t-[2px] border-foreground space-y-4">
            {/* Confidence level */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-black uppercase text-muted-foreground">Confidence</span>
                <span className="font-black text-foreground">{result.confidence}%</span>
              </div>
              <Progress value={result.confidence} className="h-3" />
            </div>

            {/* Explanation */}
            {result.explanation && (
              <div className="p-3 bg-muted border-[2px] border-foreground">
                <p className="text-sm text-foreground font-medium">
                  {result.explanation}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={playSpeech}
                disabled={isSpeaking}
                className="w-full justify-center"
              >
                {isSpeaking ? (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={3} />
                ) : (
                  <Volume2 className="h-4 w-4" strokeWidth={3} />
                )}
                {isSpeaking ? 'Generating audio' : 'Read aloud'}
              </Button>
              {speechError && (
                <p className="text-xs font-bold text-destructive">{speechError}</p>
              )}
            </div>

            {/* Sources */}
            {result.sources.length > 0 && (
              <div className="space-y-2">
                <span className="text-sm font-black uppercase text-foreground">
                  Sources
                </span>
                <div className="space-y-1">
                  {result.sources.map((source, index) => (
                    <a
                      key={index}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm font-bold text-primary hover:underline touch-target p-2 bg-card border-[2px] border-foreground hover:bg-muted transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="h-4 w-4 shrink-0" strokeWidth={3} />
                      <span className="truncate">{source.domain}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
