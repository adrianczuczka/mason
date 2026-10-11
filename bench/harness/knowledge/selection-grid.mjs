// Synthetic development cases; never an independent prevention dataset.
import { lesson } from "./prevention-fixture.mjs";
export const lessons = [
  {
    key: "scheduler",
    title: "Conditional scheduler startup protection",
    body: lesson,
    files: ["app.json", "keep.pro"],
  },
  {
    key: "announcement",
    title: "Release announcement facts",
    body: "Public release announcements describe shipped features from the reviewed changelog. Planned features remain labelled as planned. Verify version and date before publishing the announcement.",
    files: ["news.md", "changelog.md"],
  },
  {
    key: "worktree",
    title: "Isolated Git worktree directory",
    body: "Place isolated Git worktrees under .sandboxes/. The external indexer excludes this directory; .worktrees/ causes duplicate source indexing. Do not move existing checkouts as a side effect of making a new one.",
    files: ["workspace.md"],
  },
  {
    key: "upload",
    title: "Interrupted bundle upload recovery",
    body: "When an upload acknowledgement is lost, inspect the retained edit and verify artifact hash and version before uploading again. An expired edit cannot be reused; open a new edit with the unchanged artifact and version. Chunk size is an incident-specific fallback, not a global requirement.",
    files: ["publishing.md"],
  },
];
export const tasks = [
  [
    "scheduler-direct",
    "Implement forecast refresh using the background scheduler and preserve release startup.",
    ["scheduler"],
  ],
  [
    "scheduler-bash",
    "Using Bash, implement forecast refresh using the background scheduler and preserve release startup.",
    ["scheduler"],
  ],
  [
    "scheduler-paraphrase",
    "Run weather updates periodically while the application is not open.",
    ["scheduler"],
  ],
  [
    "scheduler-hidden-vocabulary",
    "Refresh forecasts every hour while the window is closed.",
    ["scheduler"],
  ],
  ["scheduler-explicit-file", "Update app.json to run periodic weather refreshes.", ["scheduler"]],
  ["scheduler-removal", "Remove the unused scheduler dependency.", ["scheduler"]],
  [
    "announcement-release",
    "Update the release announcement wording in the documentation.",
    ["announcement"],
  ],
  [
    "announcement-direct",
    "Draft a public release announcement from the changelog.",
    ["announcement"],
  ],
  ["announcement-paraphrase", "Tell users what shipped in this version.", ["announcement"]],
  ["announcement-explicit-file", "Correct the shipped feature list in news.md.", ["announcement"]],
  ["worktree-direct", "Create an isolated Git worktree for the next branch.", ["worktree"]],
  ["worktree-directory", "Make a fresh checkout in .sandboxes/ for a new branch.", ["worktree"]],
  [
    "worktree-paraphrase",
    "Prepare a separate working copy for another line of development.",
    ["worktree"],
  ],
  [
    "worktree-explicit-file",
    "Update workspace.md to explain where new checkouts belong.",
    ["worktree"],
  ],
  [
    "upload-direct",
    "Recover the interrupted bundle upload without changing its version.",
    ["upload"],
  ],
  [
    "upload-acknowledgement",
    "The bundle acknowledgement was lost. Inspect the retained publishing edit and finish the operation.",
    ["upload"],
  ],
  [
    "upload-paraphrase",
    "The server did not confirm receipt of our binary. Finish sending it without incrementing its identifier.",
    ["upload"],
  ],
  [
    "upload-explicit-file",
    "Revise publishing.md for resuming an interrupted transfer.",
    ["upload"],
  ],
  ["unrelated-greeting", "Change the greeting from hello to welcome.", []],
  ["unrelated-banner", "Change the startup banner color.", []],
  ["unrelated-application", "Correct the application copyright notice.", []],
  ["unrelated-git", "Fix the Git badge URL in the README.", []],
  ["unrelated-upload", "Add an upload button for profile photos.", []],
  [
    "joint",
    "Recover the interrupted bundle upload and draft its release announcement from the changelog.",
    ["upload", "announcement"],
  ],
].map(([name, prompt, expected]) => ({ name, prompt, expected }));

// Compare fixed hypotheses; do not tune thresholds during a run.
export function evidence(task, decision, tokenSet) {
  const tokens = tokenSet(task);
  const titleHits = [...tokenSet(decision.title)].filter((t) => tokens.has(t));
  const exactPaths = decision.files.filter((file) =>
    task.split(/[\s`"'(),;]+/).some((word) => word.replace(/[.!?:]+$/, "") === file),
  );
  return { titleHits, exactPaths };
}
export const rules = {
  positive: () => true, // Existing assembler already requires positive relevance.
  score2: (_task, decision) => decision.score >= 2,
  titleOrPath: (task, decision, tokenSet) => {
    const signal = evidence(task, decision, tokenSet);
    return signal.titleHits.length > 0 || signal.exactPaths.length > 0;
  },
};
