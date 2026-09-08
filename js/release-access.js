const exactCommit = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);

// This is deliberately narrower than a general "development" switch.  A
// public evaluation build is usable only when its generated release record
// carries every owner-authorized, non-pilot marker below.
export function isEvaluationRelease(release) {
  const evaluation = release?.evaluation;
  return release !== null && typeof release === 'object' && !Array.isArray(release) &&
    evaluation !== null && typeof evaluation === 'object' && !Array.isArray(evaluation) &&
    evaluation.channel === 'owner-evaluation' &&
    exactCommit(evaluation.sourceCommit) &&
    evaluation.cloudEnabled === false &&
    evaluation.instructionalApproval === false &&
    release.persistentPilotEligible === false &&
    release.releaseId === `evaluation-${evaluation.sourceCommit}`;
}
