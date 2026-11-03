import { runAnalysisJob, type AnalysisJob } from './analysisJob';

/** Runs road-analysis jobs off the main thread, so live traffic and the map stay smooth. */
self.onmessage = async (e: MessageEvent<{ id: number; job: AnalysisJob }>) => {
  const { id, job } = e.data;
  try {
    const out = await runAnalysisJob(job, share => (self as unknown as Worker).postMessage({ id, progress: share }), 200);
    (self as unknown as Worker).postMessage({ id, out });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
