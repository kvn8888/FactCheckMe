import { useState, useEffect, useCallback } from 'react';
import { RotateCcw, CheckCircle, XCircle, AlertTriangle, HelpCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getVerdictColor } from '@/components/VerdictBadge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { FactCheckStats, Verdict } from '@/types/factCheck';

interface StatCardProps {
  title: string;
  value: number;
  icon: React.ReactNode;
  bgColor: string;
}

function StatCard({ title, value, icon, bgColor }: StatCardProps) {
  return (
    <Card className={bgColor}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-wide text-foreground">
              {title}
            </p>
            <p className="text-3xl font-black text-foreground mt-1 tabular-nums">
              {value.toLocaleString()}
            </p>
          </div>
          <div className="p-2 bg-card border-[2px] border-foreground">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Stats() {
  const [stats, setStats] = useState<FactCheckStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      // Fetch verdict counts
      const { data: results, error: resultsError } = await supabase
        .from('fact_check_results')
        .select('verdict');

      if (resultsError) throw resultsError;

      // Fetch sessions
      const { data: sessions, error: sessionsError } = await supabase
        .from('fact_check_sessions')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(10);

      if (sessionsError) throw sessionsError;

      // Calculate stats
      const verdictCounts = (results || []).reduce(
        (acc, row) => {
          const verdict = row.verdict as Verdict;
          acc[verdict] = (acc[verdict] || 0) + 1;
          return acc;
        },
        {} as Record<Verdict, number>
      );

      setStats({
        totalChecked: results?.length || 0,
        trueCount: verdictCounts['true'] || 0,
        falseCount: verdictCounts['false'] || 0,
        partialCount: verdictCounts['partial'] || 0,
        unverifiableCount: verdictCounts['unverifiable'] || 0,
        sessions: (sessions || []).map((s) => ({
          id: s.id,
          startedAt: new Date(s.started_at),
          endedAt: s.ended_at ? new Date(s.ended_at) : null,
          claimsChecked: s.claims_checked || 0,
        })),
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
      toast.error('Failed to load statistics');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleReset = async () => {
    if (!confirm('Are you sure you want to clear all history? This cannot be undone.')) {
      return;
    }

    try {
      // Delete all results (sessions will cascade)
      const { error } = await supabase
        .from('fact_check_results')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

      if (error) throw error;

      // Also delete sessions
      await supabase
        .from('fact_check_sessions')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      setStats({
        totalChecked: 0,
        trueCount: 0,
        falseCount: 0,
        partialCount: 0,
        unverifiableCount: 0,
        sessions: [],
      });

      toast.success('All history cleared');
    } catch (error) {
      console.error('Error resetting stats:', error);
      toast.error('Failed to clear history');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="p-6 bg-muted border-[3px] border-foreground shadow-brutal">
          <p className="font-black uppercase text-muted-foreground">⏳ LOADING STATS...</p>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="p-6 bg-destructive border-[3px] border-foreground shadow-brutal">
          <p className="font-black uppercase text-destructive-foreground">❌ FAILED TO LOAD</p>
        </div>
      </div>
    );
  }

  const verdictBreakdown = [
    { verdict: 'true' as const, count: stats.trueCount, label: 'TRUE', Icon: CheckCircle, bg: 'bg-verdict-true' },
    { verdict: 'false' as const, count: stats.falseCount, label: 'FALSE', Icon: XCircle, bg: 'bg-verdict-false' },
    { verdict: 'partial' as const, count: stats.partialCount, label: 'PARTIAL', Icon: AlertTriangle, bg: 'bg-verdict-partial' },
    { verdict: 'unverifiable' as const, count: stats.unverifiableCount, label: 'UNCLEAR', Icon: HelpCircle, bg: 'bg-verdict-unverifiable' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="px-4 py-4 flex items-center justify-between safe-top">
        <h1 className="text-2xl font-black uppercase tracking-tight text-foreground">📊 STATISTICS</h1>
        <Button
          variant="destructive"
          size="sm"
          onClick={handleReset}
        >
          <RotateCcw className="h-4 w-4 mr-1" strokeWidth={3} />
          CLEAR
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-4">
        {/* Total Claims Card */}
        <Card className="bg-primary">
          <CardContent className="p-6 text-center">
            <p className="text-sm font-black uppercase tracking-wide text-primary-foreground">
              TOTAL CLAIMS CHECKED
            </p>
            <p className="text-6xl font-black text-primary-foreground mt-2 tabular-nums">
              {stats.totalChecked.toLocaleString()}
            </p>
          </CardContent>
        </Card>

        {/* Verdict Grid */}
        <div className="grid grid-cols-2 gap-3">
          {verdictBreakdown.map(({ verdict, count, label, Icon, bg }) => (
            <StatCard
              key={verdict}
              title={label}
              value={count}
              bgColor={bg}
              icon={<Icon className="h-6 w-6" strokeWidth={3} />}
            />
          ))}
        </div>

        {/* Verdict Distribution */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>DISTRIBUTION</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {verdictBreakdown.map(({ verdict, count, label }) => {
              const percentage =
                stats.totalChecked > 0
                  ? Math.round((count / stats.totalChecked) * 100)
                  : 0;
              return (
                <div key={verdict} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-black uppercase text-foreground">{label}</span>
                    <span className="font-black tabular-nums text-foreground">{percentage}%</span>
                  </div>
                  <div className="h-4 bg-muted border-[2px] border-foreground overflow-hidden">
                    <div
                      className="h-full transition-all duration-500"
                      style={{
                        width: `${percentage}%`,
                        backgroundColor: getVerdictColor(verdict),
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Session History */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>RECENT SESSIONS</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.sessions.length === 0 ? (
              <div className="p-4 bg-muted border-[2px] border-foreground text-center">
                <p className="font-bold uppercase text-muted-foreground">
                  NO SESSIONS RECORDED YET
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {stats.sessions.map((session) => (
                  <div
                    key={session.id}
                    className="flex items-center justify-between p-3 bg-muted border-[2px] border-foreground"
                  >
                    <div>
                      <p className="text-sm font-black text-foreground">
                        {new Date(session.startedAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </p>
                      <p className="text-xs font-bold uppercase text-muted-foreground">
                        {session.endedAt
                          ? `${Math.round(
                              (new Date(session.endedAt).getTime() -
                                new Date(session.startedAt).getTime()) /
                                60000
                            )} MIN`
                          : '● LIVE'}
                      </p>
                    </div>
                    <span className="text-lg font-black text-foreground tabular-nums px-3 py-1 bg-secondary border-[2px] border-foreground">
                      {session.claimsChecked}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
