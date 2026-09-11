import React, { useEffect, useState } from 'react';
import { connectionState, ConnectionState } from '../../lib/api';
import { RefreshCw, Wifi, WifiOff, Loader2 } from 'lucide-react';

export const ConnectionBadge: React.FC = () => {
  const [status, setStatus] = useState<ConnectionState>(connectionState.current);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    const unsubscribe = connectionState.subscribe((newState) => {
      setStatus(newState);
    });
    // Check initial connection
    connectionState.checkConnection();
    return () => {
      unsubscribe();
    };
  }, []);

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRetrying(true);
    try {
      const ok = await connectionState.checkConnection();
      if (ok) {
        (window as any).showToast?.('Connected to backend server', 'success');
      } else {
        (window as any).showToast?.('Backend server is unreachable. Check if FastAPI is running.', 'error');
      }
    } finally {
      setIsRetrying(false);
    }
  };

  if (status === 'saving') {
    return (
      <div 
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium font-mono border bg-amber-950/60 border-amber-500/30 text-amber-300 shadow-sm"
        title="Syncing changes with backend..."
      >
        <Loader2 size={11} className="animate-spin text-amber-400" />
        <span>Saving...</span>
      </div>
    );
  }

  if (status === 'offline') {
    return (
      <div 
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium font-mono border bg-rose-950/70 border-rose-500/40 text-rose-300 shadow-sm"
        title="Backend server offline. Changes are preserved locally."
      >
        <WifiOff size={11} className="text-rose-400 shrink-0" />
        <span>Offline</span>
        <button
          onClick={handleRetry}
          disabled={isRetrying}
          className="ml-1 p-0.5 hover:bg-rose-900/60 rounded text-rose-300 hover:text-white transition cursor-pointer disabled:opacity-50"
          title="Retry connection to backend"
        >
          <RefreshCw size={10} className={isRetrying ? 'animate-spin' : ''} />
        </button>
      </div>
    );
  }

  return (
    <div 
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium font-mono border bg-emerald-950/50 border-emerald-500/25 text-emerald-300 shadow-sm"
      title="Connected to backend server"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      <Wifi size={10} className="text-emerald-400" />
      <span>Online</span>
    </div>
  );
};
