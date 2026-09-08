export function summarize(rows) {
  const groups = {};
  for (const row of rows) {
    const key = row.host + '/' + row.arm;
    const group = groups[key] ??= { runs: 0, completedCaptureSessions: 0, toolsUsed: 0, eligibleCaptures: 0,
      acceptedCaptures: 0, rejectedCaptures: 0, pendingReviews: 0, reuseAttempts: 0, reusePasses: 0,
      completedControls: 0, passingControls: 0, controlsWithUnnecessaryRecords: 0,
      sessionFailures: 0, failedMcpCalls: 0, elapsedMs: 0, knownCostUsd: 0, sessionsWithUnknownCost: 0 };
    group.runs++;
    if (row.sessions.capture?.ok) group.completedCaptureSessions++;
    if (row.activation === 'tools-used') group.toolsUsed++;
    if (row.capture?.eligibleForReview) group.eligibleCaptures++;
    if (row.review?.verdict === 'accept') group.acceptedCaptures++;
    else if (row.review?.verdict === 'reject') group.rejectedCaptures++;
    else if (row.capture?.eligibleForReview) group.pendingReviews++;
    if (row.sessions.reuse) group.reuseAttempts++;
    if (row.reuse?.pass) group.reusePasses++;
    if (row.sessions.control?.ok) group.completedControls++;
    if (row.control?.pass) group.passingControls++;
    if (row.control?.records > 0) group.controlsWithUnnecessaryRecords++;
    for (const session of Object.values(row.sessions)) {
      if (!session.ok) group.sessionFailures++;
      group.failedMcpCalls += session.mcpFailures?.length ?? 0;
      group.elapsedMs += session.elapsedMs ?? 0;
      if (session.costUsd == null) group.sessionsWithUnknownCost++;
      else group.knownCostUsd += session.costUsd;
    }
  }
  return groups;
}
