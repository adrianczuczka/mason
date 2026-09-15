import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgress } from "../src/utils/progress.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("human terminal progress", () => {
  it("animates an unfinished stage with elapsed time and stops on failure", () => {
    vi.useFakeTimers();
    let text = "";
    const progress = createProgress({ write: value => { text += value; }, interactive: true });
    progress.step("Checking configuration");
    vi.advanceTimersByTime(1200);
    expect(text).toContain("(1s)");
    expect(text).not.toContain("✓");
    progress.stop(false);
    expect(text).toContain("✗ Checking configuration (1s)\n");
    const finished = text;
    vi.advanceTimersByTime(2000);
    expect(text).toBe(finished);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes the previous stage before starting another and fits a narrow terminal", () => {
    vi.useFakeTimers();
    let text = "";
    const progress = createProgress({ write: value => { text += value; }, interactive: true, columns: () => 24 });
    progress.step("Checking configuration");
    progress.step("Installing a long release name");
    progress.stop(); progress.stop();
    expect(text).toContain("✓ Checking configurati…");
    expect(text).toContain("✓ Installing a long re…");
    expect(vi.getTimerCount()).toBe(0);
    for (const line of text.split("\r\u001b[2K").slice(1)) expect(line.trimEnd().length).toBeLessThan(24);
  });

  it("writes one plain line per stage when redirected, without timers or terminal controls", () => {
    vi.useFakeTimers();
    let text = "";
    const progress = createProgress({ write: value => { text += value; }, interactive: false });
    progress.step("Checking configuration");
    vi.advanceTimersByTime(3000);
    progress.step("Installing Mason"); progress.stop();
    expect(text).toBe("Mason: Checking configuration…\nMason: Installing Mason…\n");
    expect(vi.getTimerCount()).toBe(0);
  });
});
