// Constructed transfer of Node #35990. Not the upstream implementation.
import { addAbortListener, getEventListeners, setMaxListeners } from "node:events";
const aborted = () => Object.assign(new Error("Operation aborted"), { name: "AbortError" });
export function referenceOperation(mode) {
  if (!["once-only", "finally-cleanup", "managed-dispose"].includes(mode))
    throw new Error("Unknown reference mode");
  return (signal, work) => {
    if (signal?.aborted) return Promise.reject(aborted());
    let listener, subscription;
    const pending = new Promise((resolve, reject) => {
      listener = () => reject(aborted());
      if (signal) {
        if (mode === "managed-dispose") subscription = addAbortListener(signal, listener);
        else signal.addEventListener("abort", listener, { once: true });
      }
      Promise.resolve().then(work).then(resolve, reject);
    });
    return mode === "once-only"
      ? pending
      : pending.finally(() => {
          if (subscription) subscription[Symbol.dispose]();
          else signal?.removeEventListener("abort", listener);
        });
  };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
export async function checkOperation(operation, { timeoutMs = 1000 } = {}) {
  const run = (signal, work) => {
    let timer;
    const pending = operation(signal, work);
    return Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Checker operation did not settle")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    const controller = new AbortController();
    setMaxListeners(0, controller.signal); // Count actual listeners, not warning thresholds.
    const baseline = () => getEventListeners(controller.signal, "abort").length;
    const observations = [];
    for (let i = 0; i < 12; i++) {
      const value = await run(controller.signal, () => Promise.resolve(i));
      observations.push({ case: "normal-" + i, value, listeners: baseline() });
    }
    const errorController = new AbortController();
    const originalError = new Error("work failed");
    let failure;
    try {
      await run(errorController.signal, () => {
        throw originalError;
      });
    } catch (e) {
      failure = e;
    }
    observations.push({
      case: "error",
      originalErrorPreserved: failure === originalError,
      listeners: getEventListeners(errorController.signal, "abort").length,
    });
    const abortController = new AbortController(),
      work = deferred(),
      started = deferred();
    const pending = run(abortController.signal, () => {
      started.resolve();
      return work.promise;
    });
    // Abort after work starts. The operation cancels waiting, not arbitrary work's side effects.
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("Operation settled before starting work");
      }),
    ]);
    abortController.abort();
    work.resolve("too late");
    let abortResult;
    try {
      abortResult = { value: await pending };
    } catch (e) {
      abortResult = { errorName: e.name };
    }
    observations.push({
      case: "abort",
      ...abortResult,
      listeners: getEventListeners(abortController.signal, "abort").length,
    });
    const preAborted = new AbortController();
    preAborted.abort();
    let calls = 0,
      preAbortName;
    try {
      await run(preAborted.signal, () => {
        calls++;
        return "unexpected";
      });
    } catch (e) {
      preAbortName = e.name;
    }
    observations.push({
      case: "pre-aborted",
      calls,
      errorName: preAbortName,
      listeners: getEventListeners(preAborted.signal, "abort").length,
    });
    const withoutSignal = await run(undefined, () => "plain");
    observations.push({ case: "no-signal", value: withoutSignal });
    const failures = observations.flatMap((o) => {
      const errors = [];
      if (o.listeners) errors.push(o.case + ": listener retained");
      if (o.case.startsWith("normal-") && o.value !== Number(o.case.slice(7)))
        errors.push(o.case + ": result changed");
      if (o.case === "error" && !o.originalErrorPreserved) errors.push("error replaced");
      if (["abort", "pre-aborted"].includes(o.case) && o.errorName !== "AbortError")
        errors.push(o.case + ": cancellation swallowed");
      if (o.case === "pre-aborted" && o.calls !== 0)
        errors.push("work started despite prior abort");
      if (o.case === "no-signal" && o.value !== "plain") errors.push("no-signal behavior changed");
      return errors;
    });
    return { pass: failures.length === 0, failures, observations };
  } catch (error) {
    return {
      pass: false,
      failures: ["checker execution failed: " + error.message],
      observations: [],
    };
  }
}
