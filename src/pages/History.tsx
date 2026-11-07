import { useState, useEffect, useCallback } from 'react';
import { Search, Filter, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FactCard } from '@/components/FactCard';
import { VerdictBadge } from '@/components/VerdictBadge';
import { getFacts } from '@/services/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { FactCheckResult, Verdict } from '@/types/factCheck';

const verdictFilters: (Verdict | 'all')[] = ['all', 'true', 'false', 'misleading', 'unverifiable'];

export default function History() {
  const [results, setResults] = useState<FactCheckResult[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<Verdict | 'all'>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchResults = useCallback(async () => {
    try {
      const response = await getFacts(100);
      if (!response.success || !response.data) throw new Error(response.error);
      setResults(response.data);
    } catch (error) {
      console.error('Error fetching results:', error);
      toast.error('Failed to load history');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchResults();
    setIsRefreshing(false);
    toast.success('History refreshed');
  };

  // Filter results
  const filteredResults = results.filter((result) => {
    const matchesSearch = result.claim
      .toLowerCase()
      .includes(searchQuery.toLowerCase());
    const matchesFilter =
      activeFilter === 'all' || result.verdict === activeFilter;
    return matchesSearch && matchesFilter;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="p-6 bg-muted border-[3px] border-foreground shadow-brutal">
          <p className="font-black uppercase text-muted-foreground">⏳ LOADING HISTORY...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="px-4 py-4 space-y-4 safe-top">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-black uppercase tracking-tight text-foreground">📜 HISTORY</h1>
          <Button
            variant="outline"
            size="icon"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="touch-target"
          >
            <RefreshCw
              className={cn('h-5 w-5', isRefreshing && 'animate-spin')}
              strokeWidth={3}
            />
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" strokeWidth={3} />
          <Input
            placeholder="SEARCH CLAIMS..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-12 font-bold uppercase"
          />
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-4 px-4">
          {verdictFilters.map((filter) => (
            <Button
              key={filter}
              variant={activeFilter === filter ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveFilter(filter)}
              className="shrink-0"
            >
              {filter === 'all' ? (
                <>
                  <Filter className="h-4 w-4 mr-1" strokeWidth={3} />
                  ALL
                </>
              ) : (
                <VerdictBadge verdict={filter} size="sm" />
              )}
            </Button>
          ))}
        </div>
      </header>

      {/* Results List */}
      <div className="flex-1 min-h-0 px-4 pb-24">
        {filteredResults.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="p-6 bg-muted border-[3px] border-foreground shadow-brutal">
              <p className="font-bold text-muted-foreground uppercase">
                {searchQuery || activeFilter !== 'all'
                  ? '🔍 NO RESULTS MATCH YOUR FILTERS'
                  : '📭 NO FACT-CHECK HISTORY YET'}
              </p>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-[calc(100vh-320px)]">
            <div className="space-y-3 pb-4">
              {filteredResults.map((result) => (
                <FactCard key={result.id} result={result} />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
