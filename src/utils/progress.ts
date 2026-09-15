/** Optional human-facing progress. Core callers stay silent unless supplied. */
export type Progress = {
  step: (message: string) => void;
  stop: (success?: boolean) => void;
};

export function createProgress(options: {
  write?: (text: string) => void;
  interactive?: boolean;
  columns?: () => number;
} = {}): Progress {
  const write = options.write ?? (text => { process.stderr.write(text); });
  const interactive = options.interactive ?? (!!process.stderr.isTTY && process.env.TERM !== "dumb" && !process.env.CI);
  const columns = options.columns ?? (() => process.stderr.columns || 80);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let message = "", started = 0, frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const elapsed = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    return seconds ? ` (${seconds}s)` : "";
  };
  const render = (prefix: string) => {
    // Keep updates on one terminal line, including when the window narrows.
    const text = `${prefix} ${message}${elapsed()}`;
    const width = Math.max(1, columns() - 1);
    write("\r\u001b[2K" + (text.length > width ? text.slice(0, width - 1) + "…" : text));
  };
  const stop = (success = true) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (message && interactive) { render(success ? "✓" : "✗"); write("\n"); }
    message = "";
  };
  return {
    step(next) {
      stop();
      message = next.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
      started = Date.now(); frame = 0;
      if (!interactive) { write(`Mason: ${message}…\n`); return; }
      render(frames[frame]);
      timer = setInterval(() => { render(frames[++frame % frames.length]); }, 100);
      timer.unref();
    },
    stop,
  };
}
