import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw, ChevronDown } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught unhandled rendering error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleRecover = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-[999999] flex items-center justify-center bg-[#060913] p-4 text-slate-100 select-none">
          <div className="w-full max-w-lg glass-panel rounded-3xl border border-rose-500/20 bg-slate-900/90 p-6 shadow-2xl space-y-5">
            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-2xl bg-rose-950/80 border border-rose-500/30 text-rose-400">
                <AlertTriangle size={24} />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-100 tracking-wide">
                  Application Encountered an Error
                </h2>
                <p className="text-xs text-rose-400/90 font-mono mt-0.5">
                  TwinCity Engine UI crash caught gracefully
                </p>
              </div>
            </div>

            {/* Message */}
            <div className="bg-slate-950/60 rounded-xl p-3.5 border border-white/5">
              <p className="text-xs text-slate-300 font-medium">
                {this.state.error?.message || 'An unexpected rendering error occurred.'}
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2.5">
              <button
                onClick={this.handleReload}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30 transition cursor-pointer"
              >
                <RotateCcw size={13} />
                <span>Reload Application</span>
              </button>
              <button
                onClick={this.handleRecover}
                className="px-4 py-2.5 rounded-xl text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800/60 border border-white/10 transition cursor-pointer"
              >
                Try to Recover
              </button>
            </div>

            {/* Collapsed Technical Details */}
            <details className="group border-t border-white/5 pt-3">
              <summary className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center justify-between cursor-pointer font-mono tracking-wider uppercase select-none">
                <span>Technical Stack Trace</span>
                <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-2.5 space-y-2">
                <pre className="p-3 rounded-xl bg-slate-950/90 text-[11px] font-mono text-rose-300/90 overflow-x-auto max-h-48 border border-white/5 whitespace-pre-wrap leading-relaxed">
                  {this.state.error?.stack || 'No component stack available.'}
                </pre>
                {this.state.errorInfo?.componentStack && (
                  <pre className="p-3 rounded-xl bg-slate-950/90 text-[10px] font-mono text-slate-400 overflow-x-auto max-h-36 border border-white/5 whitespace-pre-wrap leading-relaxed">
                    {this.state.errorInfo.componentStack}
                  </pre>
                )}
              </div>
            </details>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
