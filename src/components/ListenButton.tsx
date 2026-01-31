import { Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ListenButtonProps {
  isListening: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function ListenButton({
  isListening,
  onToggle,
  disabled = false,
}: ListenButtonProps) {
  return (
    <div className="relative flex flex-col items-center justify-center gap-4">
      {/* Decorative shapes */}
      {isListening && (
        <>
          <div className="absolute -top-4 -left-8 w-6 h-6 bg-accent border-[3px] border-foreground rotate-12" />
          <div className="absolute -bottom-2 -right-6 w-4 h-4 bg-secondary border-[3px] border-foreground -rotate-6" />
        </>
      )}

      <button
        onClick={onToggle}
        disabled={disabled}
        className={cn(
          'relative h-28 w-28 border-[4px] border-foreground font-bold transition-all duration-150',
          'flex items-center justify-center',
          isListening
            ? 'bg-secondary text-secondary-foreground shadow-brutal-xl pulse-brutal'
            : 'bg-accent text-accent-foreground shadow-brutal-lg',
          !disabled && 'hover:translate-x-[-3px] hover:translate-y-[-3px] hover:shadow-brutal-xl',
          !disabled && 'active:translate-x-[3px] active:translate-y-[3px] active:shadow-none',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        {isListening ? (
          <Mic className="h-12 w-12" strokeWidth={3} />
        ) : (
          <MicOff className="h-12 w-12" strokeWidth={3} />
        )}
      </button>

      {/* Status text */}
      <span
        className={cn(
          'text-base font-black uppercase tracking-wider px-4 py-2 border-[3px] border-foreground',
          isListening 
            ? 'bg-secondary text-secondary-foreground shadow-brutal-sm' 
            : 'bg-muted text-muted-foreground shadow-brutal-sm'
        )}
      >
        {isListening ? '● LIVE' : 'TAP TO START'}
      </span>
    </div>
  );
}
