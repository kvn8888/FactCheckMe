import { CheckCircle, XCircle, AlertTriangle, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Verdict } from '@/types/factCheck';

interface VerdictBadgeProps {
  verdict: Verdict;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}

const verdictConfig = {
  true: {
    label: 'TRUE',
    Icon: CheckCircle,
    bgClass: 'bg-verdict-true',
    textClass: 'text-verdict-true-foreground',
    iconClass: 'text-verdict-true-foreground',
  },
  false: {
    label: 'FALSE',
    Icon: XCircle,
    bgClass: 'bg-verdict-false',
    textClass: 'text-verdict-false-foreground',
    iconClass: 'text-verdict-false-foreground',
  },
  partial: {
    label: 'PARTIAL',
    Icon: AlertTriangle,
    bgClass: 'bg-verdict-partial',
    textClass: 'text-verdict-partial-foreground',
    iconClass: 'text-verdict-partial-foreground',
  },
  unverifiable: {
    label: 'UNCLEAR',
    Icon: HelpCircle,
    bgClass: 'bg-verdict-unverifiable',
    textClass: 'text-verdict-unverifiable-foreground',
    iconClass: 'text-verdict-unverifiable-foreground',
  },
};

const sizeConfig = {
  sm: {
    badge: 'px-2 py-1 text-xs gap-1',
    icon: 'h-3 w-3',
  },
  md: {
    badge: 'px-3 py-1.5 text-sm gap-1.5',
    icon: 'h-4 w-4',
  },
  lg: {
    badge: 'px-4 py-2 text-base gap-2',
    icon: 'h-5 w-5',
  },
};

export function VerdictBadge({
  verdict,
  size = 'md',
  showLabel = true,
  className,
}: VerdictBadgeProps) {
  const config = verdictConfig[verdict];
  const sizes = sizeConfig[size];
  const Icon = config.Icon;

  return (
    <span
      className={cn(
        'inline-flex items-center font-black uppercase tracking-wide border-[2px] border-foreground shadow-brutal-sm',
        config.bgClass,
        config.textClass,
        sizes.badge,
        className
      )}
    >
      <Icon className={cn(sizes.icon, config.iconClass)} strokeWidth={3} />
      {showLabel && <span>{config.label}</span>}
    </span>
  );
}

// Export for use in stats/charts
export function getVerdictColor(verdict: Verdict): string {
  const colors = {
    true: 'hsl(75 100% 50%)',
    false: 'hsl(0 100% 50%)',
    partial: 'hsl(45 100% 50%)',
    unverifiable: 'hsl(0 0% 75%)',
  };
  return colors[verdict];
}

export function getVerdictLabel(verdict: Verdict): string {
  return verdictConfig[verdict].label;
}
