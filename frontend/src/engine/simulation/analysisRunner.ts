import { runAnalysisJob, type AnalysisJob, type AnalysisOutput } from './analysisJob';

export interface RunningAnalysis { promise: Promise<AnalysisOutput>; cancel: () => void }

/**
 * Starts an analysis job in a Web Worker when the browser has them (each job
 * its own worker, ended when done or cancelled), else on this thread in slices.
 */
export function startAnalysisJob(job: AnalysisJob, onProgress: (share: number) => void): RunningAnalysis {
  const canWork = typeof Worker !== 'undefined' && typeof window !== 'undefined' && !(globalThis as { __VP_NO_WORKER__?: boolean }).__VP_NO_WORKER__;
  if (canWork) {
    let worker: Worker | null = null;
    let reject: (e: Error) => void = () => {};
    const promise = new Promise<AnalysisOutput>((resolve, rej) => {
      reject = rej;
      try {
        worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        // No module workers here: fall back to this thread
        runAnalysisJob(job, onProgress).then(resolve, rej);
        return;
      }
      worker.onmessage = (e: MessageEvent<{ id: number; progress?: number; out?: AnalysisOutput; error?: string }>) => {
        if (e.data.progress !== undefined) onProgress(e.data.progress);
        else if (e.data.out) { resolve(e.data.out); worker?.terminate(); }
        else { rej(new Error(e.data.error ?? 'The analysis failed.')); worker?.terminate(); }
      };
      worker.onerror = ev => { rej(new Error(ev.message || 'The analysis worker failed.')); worker?.terminate(); };
      worker.postMessage({ id: 1, job });
    });
    return { promise, cancel: () => { worker?.terminate(); reject(new Error('cancelled')); } };
  }
  let stop = false;
  return { promise: runAnalysisJob(job, onProgress, 25, () => stop), cancel: () => { stop = true; } };
}
