import { MessageSquare, Search, CheckSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MonitoringStatus } from '@/types/factCheck';

interface StatusBarProps {
  status: MonitoringStatus;
  className?: string;
}

interface StatItemProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  bgColor: string;
}

function StatItem({ icon, label, value, bgColor }: StatItemProps) {
  return (
    <div className={cn(
      "flex flex-col items-center gap-1 p-3 border-[3px] border-foreground shadow-brutal-sm",
      bgColor
    )}>
      <div className="flex items-center gap-1.5 text-foreground">
        {icon}
        <span className="text-xs font-black uppercase tracking-wide">{label}</span>
      </div>
      <span className="text-2xl font-black text-foreground tabular-nums">
        {value.toLocaleString()}
      </span>
    </div>
  );
}

export function StatusBar({ status, className }: StatusBarProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-3 gap-2',
        className
      )}
    >
      <StatItem
        icon={<MessageSquare className="h-4 w-4" strokeWidth={3} />}
        label="Sent"
        value={status.sentencesProcessed}
        bgColor="bg-secondary"
      />
      <StatItem
        icon={<Search className="h-4 w-4" strokeWidth={3} />}
        label="Claims"
        value={status.claimsDetected}
        bgColor="bg-accent"
      />
      <StatItem
        icon={<CheckSquare className="h-4 w-4" strokeWidth={3} />}
        label="Checked"
        value={status.factsChecked}
        bgColor="bg-primary"
      />
    </div>
  );
}
