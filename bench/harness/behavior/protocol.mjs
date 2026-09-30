import { createHash } from 'node:crypto';
export const arms = ['baseline', 'instructions', 'hooks'];
export const tasks = [
  { id: 'rename-root', kind: 'rename', from: 'old-module', to: 'greeting-module' },
  { id: 'rename-nested', kind: 'rename', from: 'src/message', to: 'src/greeting' },
  { id: 'rename-backlog', kind: 'rename', from: 'lib/old', to: 'lib/greeting', backlog: true },
  { id: 'command-name', kind: 'command', from: 'preview', to: 'greet' },
  { id: 'command-backlog', kind: 'command', from: 'start-old', to: 'start', backlog: true },
  { id: 'control-greeting', kind: 'control' },
  { id: 'control-backlog', kind: 'control', backlog: true },
  { id: 'lesson-indexer', kind: 'lesson', topic: 'indexer' },
  { id: 'lesson-cache', kind: 'lesson', topic: 'cache' },
  { id: 'lesson-uncertain', kind: 'lesson', topic: 'uncertain' },
];
export const digest = value => createHash('sha256').update(value).digest('hex');
export function random(seed) {
  let state = parseInt(digest(String(seed)).slice(0, 8), 16) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
export function shuffled(items, rng) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function schedule(seed, repeats = 3, selected = tasks.map(t => t.id)) {
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !tasks.some(t => t.id === id))) throw new Error('Unknown, empty or duplicate task selection');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeats must be 1..10');
  const rng = random(seed);
  const blocks = shuffled(tasks.filter(task => selected.includes(task.id)).flatMap(task => Array.from({ length: repeats }, (_, repeat) => ({ task: task.id, repeat }))), rng);
  return blocks.flatMap(block => shuffled(arms, rng).map(arm => ({ ...block, arm,
    id: digest(`${seed}:${block.task}:${block.repeat}:${arm}`).slice(0, 16) })));
}
export function prompt(task) {
  if (task.kind === 'rename') return `Rename the ${task.from} directory to ${task.to} and update the project to use it. Keep behavior unchanged. Make the source migration first and run node app.mjs to verify it before finishing project cleanup. Leave unrelated existing problems alone.`;
  if (task.kind === 'command') return `Rename the npm script ${task.from} to ${task.to}. Keep its behavior unchanged and leave unrelated existing problems alone.`;
  if (task.kind === 'control') return 'Change the greeting from hello to welcome. Keep the module organization unchanged and leave unrelated existing problems alone.';
  return 'Investigate the incident in incident.md. Explain what the evidence establishes, what remains uncertain, and the next step. Do not change the implementation or claim that a proposed remedy has been tested.';
}
export function summarize(rows) {
  const completed = rows.filter(r => r.status === 'complete');
  const rates = Object.fromEntries(arms.map(arm => {
    const group = completed.filter(r => r.arm === arm);
    const scored = group.filter(r => r.taskKind !== 'lesson');
    const passed = scored.filter(r => r.session?.ok && r.grade?.pass).length;
    const costs = group.map(r => r.session?.costUsd).filter(n => typeof n === 'number');
    return [arm, { attempted: group.length, objectivelyScored: scored.length, passed, behaviorPasses: scored.filter(r => r.session?.ok && r.grade?.behavior).length, documentationPasses: scored.filter(r => r.session?.ok && r.grade?.documentation).length,
      successRate: scored.length ? passed / scored.length : null,
      modelMismatches: group.filter(r => r.session?.ok && r.modelVerified === false).length,
      activationFailures: group.filter(r => r.integrationValid === false).length,
      scopeViolations: group.filter(r => r.grade?.scopeViolations?.length).length,
      lessonReviewPending: group.filter(r => r.taskKind === 'lesson').length,
      costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      costCoverage: costs.length, elapsedMs: group.reduce((n, r) => n + (r.session?.elapsedMs ?? 0), 0) }];
  }));
  // Pair identical task/repeat cells; never drop failed model sessions from the score.
  const comparisons = [['instructions', 'baseline'], ['hooks', 'instructions']].map(([a, b]) => {
    const differences = [];
    for (const task of tasks.filter(t => t.kind !== 'lesson')) {
      const left = completed.filter(r => r.arm === a && r.task === task.id);
      const paired = left.flatMap(x => {
        const y = completed.find(r => r.arm === b && r.task === task.id && r.repeat === x.repeat);
        return y ? [Number(!!(x.session?.ok && x.grade?.pass)) - Number(!!(y.session?.ok && y.grade?.pass))] : [];
      });
      if (paired.length) differences.push(paired.reduce((n, x) => n + x, 0) / paired.length);
    }
    if (!differences.length) return { a, b, taskFamilies: 0, difference: null, interval: null };
    const rng = random(`${a}:${b}:interval`);
    const samples = Array.from({ length: 2000 }, () => differences.reduce(n => n + differences[Math.floor(rng() * differences.length)], 0) / differences.length).sort((x, y) => x - y);
    return { a, b, taskFamilies: differences.length, difference: differences.reduce((n, x) => n + x, 0) / differences.length,
      interval: [samples[50], samples[1949]], note: 'Exploratory 95% task-cluster bootstrap interval; few synthetic tasks, not general performance evidence.' };
  });
  return { rates, comparisons, complete: completed.length, interrupted: rows.filter(r => r.status === 'interrupted').length };
}
