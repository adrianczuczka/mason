// A local protocol model, not the Play API. No credentials or network calls.
export const operations = ['inspect_edit', 'create_edit', 'upload_bundle', 'attach_mapping', 'finish_edit'];
export function initialState(scenario, release) {
  if (!['expired', 'empty', 'matched', 'mismatched'].includes(scenario)) throw new Error('Unknown publishing scenario');
  return { edits: { [release.editId]: { status: scenario === 'expired' ? 'expired' : 'active',
    bundle: ['matched', 'mismatched'].includes(scenario) ? { version: release.version, sha256: scenario === 'matched' ? release.sha256 : '0'.repeat(64) } : null,
    mapping: false, finished: false } }, next: 1 };
}
export function transition(state, name, args, release) {
  if (!operations.includes(name) || !args || typeof args !== 'object' || Object.keys(args).some(k => k !== 'editId')
    || name !== 'create_edit' && typeof args.editId !== 'string' || name === 'create_edit' && Object.keys(args).length) throw new Error('Invalid publishing call');
  if (name === 'create_edit') {
    const editId = 'recovery-' + state.next++;
    state.edits[editId] = { status: 'active', bundle: null, mapping: false, finished: false };
    return { editId, status: 'active' };
  }
  const edit = state.edits[args.editId];
  if (!edit) return { error: 'unknown_edit' };
  if (name === 'inspect_edit') return { editId: args.editId, ...structuredClone(edit) };
  if (edit.status !== 'active' || edit.finished) return { error: 'edit_unavailable' };
  if (name === 'upload_bundle') {
    if (edit.bundle) return { error: 'bundle_already_present' };
    edit.bundle = { version: release.version, sha256: release.sha256 };
    return { editId: args.editId, bundle: edit.bundle };
  }
  if (edit.bundle?.version !== release.version || edit.bundle?.sha256 !== release.sha256) return { error: 'artifact_identity_unverified' };
  if (name === 'attach_mapping') { edit.mapping = true; return { editId: args.editId, mapping: true }; }
  if (!edit.mapping) return { error: 'mapping_missing' };
  edit.finished = true;
  return { editId: args.editId, finished: true, bundle: edit.bundle };
}

export function gradeActions(events, release, scenario) {
  const failures = [], calls = events.filter(e => e.event === 'publish-result');
  const state = initialState(scenario, release);
  for (const e of calls) {
    const expected = transition(state, e.name, e.args, release);
    if (JSON.stringify(expected) !== JSON.stringify(e.response)) failures.push('publishing receipt does not replay');
    if (expected.error) failures.push('unsuccessful publishing operation: ' + e.name + '/' + expected.error);
  }
  const firstWrite = calls.findIndex(e => e.name !== 'inspect_edit');
  if (firstWrite < 0 || !calls.slice(0, firstWrite).some(e => e.name === 'inspect_edit' && e.args.editId === release.editId)) failures.push('original edit not inspected before side effects');
  const creates = calls.filter(e => e.name === 'create_edit'), uploads = calls.filter(e => e.name === 'upload_bundle');
  if (creates.length !== (scenario === 'expired' ? 1 : 0)) failures.push('unnecessary or missing replacement edit');
  if (uploads.length !== (scenario === 'matched' ? 0 : 1)) failures.push('unnecessary or missing upload');
  const completed = Object.values(state.edits).filter(e => e.finished);
  if (completed.length !== 1 || completed[0].bundle?.version !== release.version || completed[0].bundle?.sha256 !== release.sha256) failures.push('release identity or completion failed');
  return { pass: !failures.length, failures, state, actions: calls.map(e => e.name) };
}
