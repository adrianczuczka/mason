import { AsyncLocalStorage } from "node:async_hooks";

type Timing = { calls: number; totalMs: number };
const profiles = new AsyncLocalStorage<Record<string, Timing>>();

/** Opt-in, invocation-local timings. Labels are fixed in source; no repository data. */
export async function profilePhase<T>(label: string, run: () => Promise<T>): Promise<T> {
  const phases = profiles.getStore();
  if (!phases) return run();
  const start = performance.now();
  try { return await run(); }
  finally {
    const timing = phases[label] ??= { calls: 0, totalMs: 0 };
    timing.calls++;
    timing.totalMs += performance.now() - start;
  }
}

export async function withProfile<T>(run: () => Promise<T>, emit: (json: string) => void): Promise<T> {
  const phases: Record<string, Timing> = {};
  const start = performance.now();
  return profiles.run(phases, async () => {
    try { return await run(); }
    finally {
      emit(JSON.stringify({ kind: "mason-profile", version: 1, totalMs: performance.now() - start, phases }));
    }
  });
}
