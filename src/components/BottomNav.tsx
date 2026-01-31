import { Link, useLocation } from 'react-router-dom';
import { Radio, History, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  {
    path: '/',
    label: 'MONITOR',
    icon: <Radio className="h-6 w-6" strokeWidth={3} />,
  },
  {
    path: '/history',
    label: 'HISTORY',
    icon: <History className="h-6 w-6" strokeWidth={3} />,
  },
  {
    path: '/stats',
    label: 'STATS',
    icon: <BarChart3 className="h-6 w-6" strokeWidth={3} />,
  },
];

export function BottomNav() {
  const location = useLocation();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t-[4px] border-foreground safe-bottom">
      <div className="flex items-center justify-around h-20">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'flex flex-col items-center justify-center gap-1 flex-1 h-full touch-target transition-all duration-150',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-foreground hover:bg-muted'
              )}
            >
              {item.icon}
              <span className="text-xs font-black uppercase tracking-wider">
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
