import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareFixture, writeFiles } from "./fixture.mjs";
import { gradePatch } from "./grade.mjs";

/** A working reference must pass; the original and specified bad patches must fail. */
export async function validateTasks(tasks, progress = () => {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mason-patch-validation-"));
  const results = [];
  try {
    for (const task of tasks) {
      const fixture = await prepareFixture(path.join(directory, task.id), task, "baseline");
      const before = await gradePatch(task, fixture);
      if (before.passed || !before.publicTests?.passed || before.integrity.length) throw new Error(`${task.id}: invalid starting fixture`);
      await writeFiles(fixture.repo, task.reference);
      const reference = await gradePatch(task, fixture);
      if (!reference.passed) throw new Error(`${task.id}: reference failed: ${JSON.stringify(reference)}`);
      const mutations = [];
      for (const [index, mutation] of task.mutations.entries()) {
        const bad = await prepareFixture(path.join(directory, `${task.id}-bad-${index}`), task, "baseline");
        await writeFiles(bad.repo, mutation.files);
        const result = await gradePatch(task, bad);
        if (result.passed || !result.checks.some(c => c.id === mutation.caughtBy && !c.passed)) throw new Error(`${task.id}: grader missed ${mutation.id}`);
        mutations.push({ id: mutation.id, caughtBy: mutation.caughtBy });
      }
      const result = { task: task.id, originalPasses: false, referencePasses: true, mutations };
      results.push(result);
      progress(result);
    }
    return results;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
