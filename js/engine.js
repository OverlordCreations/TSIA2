export const ACTIONS = Object.freeze([
  'ADVANCE',
  'RETRY',
  'DIAGNOSE',
  'REGRESS',
  'REMEDIATE',
  'TRANSFER',
  'REVIEW',
  'TEACHER_INTERVENTION'
]);

export const SKILL_STATUSES = Object.freeze(['Not Assessed', 'Emerging', 'Developing', 'Near Mastery', 'Mastered']);
const STATUS = SKILL_STATUSES;
// A domain becomes selectable only when its exported diagnostic entries are
// present. The data filter below remains the final guard against a forged or
// incomplete bundle.
const ASSESSED_DOMAIN_CODES = new Set(['QR', 'AR', 'GSR', 'PSR']);
const DOMAIN_ORDER = ['QR', 'AR', 'GSR', 'PSR'];

export function getDomainEntryOptions(questionData) {
  const declaredEntries = new Set(questionData?.diagnosticEntryQuestionIds ?? []);
  const questions = questionData?.questions ?? [];
  const options = new Map(DOMAIN_ORDER.map(code => [code, {
    code,
    available: false,
    entryQuestionIds: []
  }]));

  for (const question of questions) {
    const code = question.metadata?.domainCode;
    if (!ASSESSED_DOMAIN_CODES.has(code) || question.role !== 'diagnostic-entry' || !declaredEntries.has(question.id)) continue;
    const option = options.get(code);
    option.available = true;
    option.entryQuestionIds.push(question.id);
  }
  return options;
}

export function getInitialView(state) {
  if (state?.safeExit) return 'safe-exit';
  if (state?.currentQuestionId === null && Array.isArray(state?.attempts) && state.attempts.length > 0) return 'complete';
  return 'domain-selection';
}

export function createInitialState(startQuestionId) {
  return {
    currentQuestionId: startQuestionId,
    mastery: {},
    attempts: [],
    hintLevel: 0,
    safeExit: null,
    sessionStartedAt: new Date().toISOString()
  };
}

function blankMastery() {
  return {
    score: 0,
    independentCorrect: 0,
    assistedCorrect: 0,
    incorrect: 0,
    transferCorrect: 0,
    distinctCorrectQuestions: [],
    recent: [],
    needsIndependentAfterHighHint: false,
    status: 'Not Assessed'
  };
}

function deriveStatus(record, requirements) {
  const minimumCorrect = requirements?.independentCorrect ?? 2;
  const minimumDistinctContexts = requirements?.minimumDistinctContexts ?? 2;
  const transferRequired = requirements?.transferRequired ?? true;
  const highHintUsePreventsMasteredStatus = requirements?.highHintUsePreventsMasteredStatus ?? true;
  const masteryAvailable = requirements?.masteryAvailable ?? true;
  const distinctContexts = record.distinctCorrectQuestions.length;

  if (
    record.independentCorrect >= minimumCorrect &&
    distinctContexts >= minimumDistinctContexts &&
    (!transferRequired || record.transferCorrect >= 1) &&
    record.score >= 6 &&
    masteryAvailable &&
    (!highHintUsePreventsMasteredStatus || !record.needsIndependentAfterHighHint)
  ) return 'Mastered';
  if (record.score >= 4 && record.independentCorrect >= 2) return 'Near Mastery';
  if (record.score >= 2) return 'Developing';
  if (record.independentCorrect + record.assistedCorrect + record.incorrect > 0) return 'Emerging';
  return 'Not Assessed';
}

function hasNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function hasCanonicalEvidenceShape(record) {
  return Boolean(record) && typeof record === 'object' && !Array.isArray(record) &&
    Number.isFinite(record.score) && record.score >= 0 && record.score <= 10 &&
    hasNonnegativeInteger(record.independentCorrect) &&
    hasNonnegativeInteger(record.assistedCorrect) &&
    hasNonnegativeInteger(record.incorrect) &&
    hasNonnegativeInteger(record.transferCorrect) &&
    Array.isArray(record.distinctCorrectQuestions) &&
    record.distinctCorrectQuestions.every(questionId => typeof questionId === 'string' && questionId) &&
    new Set(record.distinctCorrectQuestions).size === record.distinctCorrectQuestions.length &&
    Array.isArray(record.recent) && record.recent.every(item =>
      item && typeof item === 'object' && typeof item.questionId === 'string' && item.questionId &&
      typeof item.correct === 'boolean' && Number.isInteger(item.hintLevel) && item.hintLevel >= 0 && item.hintLevel <= 3
    ) &&
    typeof record.needsIndependentAfterHighHint === 'boolean' && STATUS.includes(record.status);
}

function hasVerifiedEvidenceReferences(state, skill, record, questionsById) {
  if (!(questionsById instanceof Map) || !skill?.id) return false;
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  const questionFor = questionId => {
    const question = questionsById.get(questionId);
    return question?.skillId === skill.id ? question : null;
  };
  const matchingAttempt = (questionId, correct, hintLevel = null) => attempts.some(attempt =>
    attempt?.questionId === questionId &&
    attempt.attemptedSkill === skill.id &&
    attempt.correct === correct &&
    attempt.assistance?.hintLevel === (hintLevel ?? attempt.assistance?.hintLevel) &&
    attempt.assistance?.independent === (hintLevel === null ? attempt.assistance?.independent : hintLevel === 0)
  );

  // A current question is merely open, not attempted.  Distinct correct
  // evidence and recent evidence must be backed by a persisted response with
  // the same correctness and help level; a question ID alone cannot create
  // readiness after a reload.
  return record.distinctCorrectQuestions.every(questionId =>
    questionFor(questionId) && matchingAttempt(questionId, true)
  ) && record.recent.every(item =>
    questionFor(item.questionId) && matchingAttempt(item.questionId, item.correct, item.hintLevel)
  );
}

function isEngineRetainedMasteryAfterOneContradiction(state, skill, record, requirements) {
  if (record.status !== 'Mastered' || deriveStatus(record, requirements) === 'Mastered') return false;
  const minimumCorrect = requirements?.independentCorrect ?? 2;
  const minimumDistinctContexts = requirements?.minimumDistinctContexts ?? 2;
  const transferRequired = requirements?.transferRequired ?? true;
  const lastRecent = record.recent.at(-1);
  if (
    !lastRecent || lastRecent.correct || lastRecent.hintLevel !== 0 ||
    record.score !== 5 || record.independentCorrect < minimumCorrect ||
    record.distinctCorrectQuestions.length < minimumDistinctContexts ||
    (transferRequired && record.transferCorrect < 1) ||
    requirements?.masteryAvailable === false || record.needsIndependentAfterHighHint
  ) return false;
  return (state?.attempts ?? []).some(attempt =>
    attempt?.questionId === lastRecent.questionId && attempt.attemptedSkill === skill.id &&
    attempt.correct === false && attempt.assistance?.hintLevel === 0 && attempt.assistance?.independent === true &&
    attempt.masteryEvidenceChange?.skillId === skill.id &&
    attempt.masteryEvidenceChange?.previousStatus === 'Mastered' &&
    attempt.masteryEvidenceChange?.newStatus === 'Mastered' &&
    attempt.masteryEvidenceChange?.scoreDelta === -1
  );
}

function relationshipFor(skill, candidateId) {
  if (!skill || !candidateId) return null;
  if (skill.requiredPrerequisites?.includes(candidateId)) return 'required prerequisite';
  if (skill.supportingSkills?.includes(candidateId)) return 'supporting skill';
  if (skill.regressionTargets?.includes(candidateId)) return 'regression target';
  if (skill.alternativePrerequisiteGroups?.some(group => group.skillIds.includes(candidateId))) {
    return 'alternative prerequisite pathway';
  }
  return null;
}

const READY_STATUSES = new Set(['Near Mastery', 'Mastered']);

function dependencyEvidence(skillId, state, skillsById, questionsById) {
  const skill = skillsById?.get(skillId);
  // Only an exported, explicitly authored handoff can be non-blocking. An
  // unknown ID is broken prerequisite data and must stay unassessed/blocking.
  if (!skill) return { skillId, status: 'Not Assessed', state: 'unassessed' };
  if (skill.handoff) return { skillId, status: 'Not Assessed', state: 'external-handoff' };
  const status = getSkillStatus(state, skill, questionsById);
  if (status === 'Not Assessed') return { skillId, status, state: 'unassessed' };
  if (READY_STATUSES.has(status)) return { skillId, status, state: 'ready' };
  const record = state.mastery[skillId];
  return {
    skillId, status,
    state: record.incorrect > record.independentCorrect + record.assistedCorrect ? 'weak-evidence' : 'developing'
  };
}

export function assessReadiness(skill, state, skillsById = null, questionsById = null) {
  if (!skill) return null;
  const required = (skill.requiredPrerequisites ?? []).map(id => dependencyEvidence(id, state, skillsById, questionsById));
  const alternatives = (skill.alternativePrerequisiteGroups ?? []).map(group => {
    const pathways = (group.skillIds ?? []).map(id => dependencyEvidence(id, state, skillsById, questionsById));
    const minimumRequired = group.minimumRequired ?? group.minimumSatisfied ?? 1;
    return {
      minimumRequired,
      readyCount: pathways.filter(item => item.state === 'ready').length,
      pathways
    };
  });
  const supporting = (skill.supportingSkills ?? []).map(id => dependencyEvidence(id, state, skillsById, questionsById));
  return {
    required,
    alternatives,
    supporting,
    verified: required.every(item => item.state === 'ready' || item.state === 'external-handoff') &&
      alternatives.every(group => group.readyCount >= group.minimumRequired),
    blockingEvidence: required.filter(item => item.state === 'weak-evidence')
  };
}

function updateMastery({ state, skill, question, correct, hintLevel }) {
  const previous = structuredClone(state.mastery[skill.id] ?? blankMastery());
  const next = structuredClone(previous);
  const independent = hintLevel === 0;

  if (correct) {
    if (independent) next.independentCorrect += 1;
    else next.assistedCorrect += 1;
    if (hintLevel >= 2) next.needsIndependentAfterHighHint = true;
    else if (independent) next.needsIndependentAfterHighHint = false;
    if (!next.distinctCorrectQuestions.includes(question.id)) {
      next.distinctCorrectQuestions.push(question.id);
    }
    if (question.role === 'transfer') next.transferCorrect += 1;
    next.score = Math.min(10, next.score + (question.role === 'transfer' ? 3 : independent ? 2 : 1));
  } else {
    next.incorrect += 1;
    next.score = Math.max(0, next.score - 1);
  }

  next.recent = [...next.recent, { questionId: question.id, correct, hintLevel }].slice(-4);
  next.status = deriveStatus(next, skill.masteryEvidence);

  // Preserve established mastery after one contradiction; require repeated
  // independent misses before lowering the status.
  if (
    !correct && previous.status === 'Mastered' &&
    skill.masteryEvidence?.masteryAvailable !== false &&
    !next.needsIndependentAfterHighHint
  ) {
    const independentMisses = next.recent.filter(item => !item.correct && item.hintLevel === 0).length;
    next.status = independentMisses >= 2 ? 'Near Mastery' : 'Mastered';
  }

  state.mastery[skill.id] = next;
  return {
    skillId: skill.id,
    previousStatus: previous.status,
    newStatus: next.status,
    scoreDelta: next.score - previous.score,
    independentCorrectDelta: next.independentCorrect - previous.independentCorrect,
    transferCorrectDelta: next.transferCorrect - previous.transferCorrect
  };
}

function hasConflictingRecentEvidence(record) {
  const recent = record?.recent ?? [];
  return recent.some(item => item.correct) && recent.some(item => !item.correct);
}

function chooseAction({ question, choice, state, skill, correct }) {
  const configured = correct ? question.correctRoute : choice.route;
  let action = configured?.action ?? (correct ? 'ADVANCE' : 'RETRY');

  const record = state.mastery[skill.id];
  const classifiedEvidence = choice.evidence?.misconceptionId ||
    choice.evidence?.prerequisiteSkillId ||
    ['misconception-hypothesis', 'prerequisite-hypothesis'].includes(choice.evidence?.kind);
  const unresolvedGenericError = !correct && !classifiedEvidence;
  // A generic miss is evidence that another response is useful, not evidence
  // that a particular prerequisite is broken.  Only an authored, classified
  // diagnosis may send a learner backward.
  if (unresolvedGenericError && action === 'REGRESS') action = 'RETRY';
  if (unresolvedGenericError && hasConflictingRecentEvidence(record)) action = 'REVIEW';

  if (!ACTIONS.includes(action)) throw new Error(`Unsupported routing action: ${action}`);
  return { action, configured };
}

const GLOBAL_ROLE_ORDER = new Map([
  ['diagnostic-entry', 0], ['diagnostic', 1], ['practice', 2], ['independent', 3]
]);

function stableQuestionOrder(left, right) {
  return (GLOBAL_ROLE_ORDER.get(left.role) ?? 99) - (GLOBAL_ROLE_ORDER.get(right.role) ?? 99) || left.id.localeCompare(right.id);
}

function currentSkillNeedsTransfer(skill, state, questionsById) {
  const record = state.mastery[skill?.id];
  return getSkillStatus(state, skill, questionsById) === 'Near Mastery' && (record?.transferCorrect ?? 0) < 1;
}

function normalizeSkillId(value) {
  return typeof value === 'string' && value ? value : null;
}

function freshQuestionsForSkill({ skillId, state, questionsById, domainCode = null, allowTransfer = false }) {
  return [...questionsById.values()]
    .filter(question => question.skillId === skillId &&
      !hasAttemptedQuestion(state, question.id) &&
      (GLOBAL_ROLE_ORDER.has(question.role) || (allowTransfer && question.role === 'transfer')) &&
      (!domainCode || question.metadata?.domainCode === domainCode))
    .sort(stableQuestionOrder);
}

function freshTransferQuestionsForSkill({ skillId, state, questionsById, domainCode = null }) {
  return [...questionsById.values()]
    .filter(question => question.skillId === skillId && question.role === 'transfer' &&
      !hasAttemptedQuestion(state, question.id) && (!domainCode || question.metadata?.domainCode === domainCode))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function firstBlockingPrerequisite(skill, state, skillsById, questionsById, domainCode) {
  const readiness = assessReadiness(skill, state, skillsById, questionsById);
  if (!readiness || readiness.verified) return null;
  const ordered = [
    // A prerequisite with sufficient current evidence is not a blocker merely
    // because another required relationship remains unverified.
    ...readiness.required.filter(item => item.state !== 'ready'),
    ...readiness.alternatives.flatMap(group => group.pathways.filter(item => item.state !== 'ready'))
  ];
  let missingQuestion = null;
  for (const item of ordered) {
    const candidate = skillsById.get(item.skillId);
    if (!candidate) continue;
    if (candidate.handoff) return { skillId: item.skillId, questionId: null, readiness, handoff: true };
    const question = freshQuestionsForSkill({ skillId: item.skillId, state, questionsById, domainCode })[0];
    if (question) return { skillId: item.skillId, questionId: question.id, readiness, handoff: false };
    if (!missingQuestion) missingQuestion = { skillId: item.skillId, questionId: null, readiness, handoff: false };
  }
  return missingQuestion;
}

function hasEvidenceForSkill(state, skillId) {
  return state.attempts.some(attempt => attempt.attemptedSkill === skillId || attempt.skillId === skillId);
}

function skillIsMastered(state, skill, questionsById) {
  return getSkillStatus(state, skill, questionsById) === 'Mastered';
}

function availableSkillQuestions(skill, state, questionsById, domainCode) {
  return freshQuestionsForSkill({ skillId: skill.id, state, questionsById, domainCode }).length > 0;
}

function orderedNearbySkills(startSkillId, skillsById) {
  const visited = new Set();
  const nearby = [];
  let frontier = startSkillId ? [startSkillId] : [];
  while (frontier.length) {
    const nextFrontier = [];
    for (const skillId of frontier.sort((left, right) => left.localeCompare(right))) {
      if (visited.has(skillId)) continue;
      visited.add(skillId);
      const skill = skillsById.get(skillId);
      if (!skill || skill.handoff) continue;
      nearby.push(skill);
      for (const successor of [...(skill.successors ?? []), ...(skill.transferTargets ?? [])]) {
        if (!visited.has(successor)) nextFrontier.push(successor);
      }
    }
    frontier = nextFrontier;
  }
  return nearby;
}

/**
 * Deterministically choose a fresh, student-safe next task at an explicit
 * start/next boundary.  It returns identifiers and categories for audit; the
 * UI owns all student-facing wording.
 */
export function selectRecommendedNext({ state, skillsById, questionsById, questionData = null, domainCode = null, currentSkillId = null }) {
  const skills = [...skillsById.values()].filter(skill => !skill.handoff && availableSkillQuestions(skill, state, questionsById, domainCode))
    .sort((left, right) => left.id.localeCompare(right.id));
  const safe = (reasonCategory, details = {}) => ({
    selectedQuestionId: null, selectedSkillId: details.skillId ?? null,
    recommendedNextAction: 'TEACHER_INTERVENTION', readiness: details.readiness ?? null,
    reasonCategory, authoredTargetAccepted: null, authoredTargetOverridden: false,
    blockerSkillId: details.blockerSkillId ?? null, handoff: Boolean(details.handoff),
    safeExit: { reason: details.handoff ? 'foundational-handoff' : 'no-fresh-recommendation', skillId: normalizeSkillId(details.skillId) ?? normalizeSkillId(currentSkillId) }
  });
  const result = (question, reasonCategory, details = {}) => {
    if (!question) return safe(reasonCategory === 'blocking-prerequisite' ? 'domain-constrained-no-fresh-blocker' : 'no-fresh-question', details);
    return ({
    selectedQuestionId: question.id, selectedSkillId: question.skillId,
    recommendedNextAction: details.action ?? 'RETRY', readiness: details.readiness ?? assessReadiness(skillsById.get(question.skillId), state, skillsById, questionsById),
    reasonCategory, authoredTargetAccepted: details.authoredTargetAccepted ?? null,
    authoredTargetOverridden: Boolean(details.authoredTargetOverridden),
    blockerSkillId: normalizeSkillId(details.blockerSkillId), handoff: false, safeExit: null
    });
  };

  // Continue gathering fresh evidence for the learner's active partially
  // assessed skill before moving the frontier elsewhere.
  const activeSkillId = currentSkillId === false ? null : currentSkillId ?? state.attempts.at(-1)?.attemptedSkill ?? null;
  if (activeSkillId && !skillIsMastered(state, skillsById.get(activeSkillId), questionsById)) {
    const active = skillsById.get(activeSkillId);
    const blocker = active && firstBlockingPrerequisite(active, state, skillsById, questionsById, domainCode);
    if (blocker) {
      if (blocker.questionId) return result(questionsById.get(blocker.questionId), 'blocking-prerequisite', { action: 'REGRESS', readiness: blocker.readiness, blockerSkillId: blocker.skillId });
      return safe(blocker.handoff ? 'blocking-handoff' : 'domain-constrained-no-fresh-blocker', { skillId: activeSkillId, blockerSkillId: blocker.skillId, readiness: blocker.readiness, handoff: blocker.handoff });
    }
    const fresh = freshQuestionsForSkill({ skillId: activeSkillId, state, questionsById, domainCode,
      allowTransfer: currentSkillNeedsTransfer(active, state, questionsById) })[0];
    if (fresh) return result(fresh, 'current-skill-evidence', { action: 'RETRY' });
  }

  // An already-assessed but incomplete skill with available fresh evidence is
  // the next most useful local move.
  for (const skill of skills) {
    if (!skillIsMastered(state, skill, questionsById) && hasEvidenceForSkill(state, skill.id)) {
      const blocker = firstBlockingPrerequisite(skill, state, skillsById, questionsById, domainCode);
      if (blocker?.questionId) return result(questionsById.get(blocker.questionId), 'blocking-prerequisite', { action: 'REGRESS', readiness: blocker.readiness, blockerSkillId: blocker.skillId });
      if (blocker) return safe(blocker.handoff ? 'blocking-handoff' : 'domain-constrained-no-fresh-blocker', { skillId: skill.id, blockerSkillId: blocker.skillId, readiness: blocker.readiness, handoff: blocker.handoff });
      return result(freshQuestionsForSkill({ skillId: skill.id, state, questionsById, domainCode })[0], 'current-skill-evidence', { action: 'RETRY' });
    }
  }

  // With no evidence, select a fixed first domain entry.  This is a neutral
  // baseline, never a claim of personalization.
  const entries = (questionData?.diagnosticEntryQuestionIds ?? [])
    .map(id => questionsById.get(id)).filter(question => question && question.role === 'diagnostic-entry' &&
      (!domainCode || question.metadata?.domainCode === domainCode) && !hasAttemptedQuestion(state, question.id));
  if (state.attempts.length === 0 && entries.length) return result(entries[0], 'baseline-diagnostic', { action: 'DIAGNOSE' });

  // Once evidence exists, enter the nearest ready unassessed frontier in
  // graph source order instead of revisiting an already-mastered skill.
  const selectableSkillIds = new Set(skills.map(skill => skill.id));
  const proximity = activeSkillId ? orderedNearbySkills(activeSkillId, skillsById).filter(skill => selectableSkillIds.has(skill.id)) : [];
  for (const skill of [...proximity, ...skills.filter(candidate => !proximity.some(nearby => nearby.id === candidate.id))]) {
    if (skillIsMastered(state, skill, questionsById) || hasEvidenceForSkill(state, skill.id)) continue;
    const readiness = assessReadiness(skill, state, skillsById, questionsById);
    if (readiness?.verified) {
      const fresh = freshQuestionsForSkill({ skillId: skill.id, state, questionsById, domainCode })[0];
      if (fresh) return result(fresh, 'ready-frontier', { action: 'ADVANCE', readiness });
    }
  }

  // If no connected frontier is ready, an unattempted direct entry is still a
  // useful bounded way to gather evidence in the selected domain.
  if (entries.length) return result(entries[0], 'unassessed-diagnostic', { action: 'DIAGNOSE' });

  return safe('no-fresh-question', { skillId: activeSkillId });
}

/** Resolve an explicit domain start without mutating a saved session. */
export function selectDomainStart({ state, domainCode, skillsById, questionsById, questionData }) {
  const current = state.currentQuestionId ? questionsById.get(state.currentQuestionId) : null;
  const currentDomain = current?.metadata?.domainCode ?? null;
  const pendingId = state.pendingQuestionIds?.[domainCode] ?? null;
  const pendingQuestion = typeof pendingId === 'string' ? questionsById.get(pendingId) : null;
  if (ASSESSED_DOMAIN_CODES.has(domainCode) && pendingQuestion?.metadata?.domainCode === domainCode) {
    return { selectedQuestionId: pendingQuestion.id, fromPending: true, recommendation: null, safeExit: null };
  }
  if (current && currentDomain === domainCode) {
    return { selectedQuestionId: current.id, fromPending: false, recommendation: null, safeExit: null };
  }
  const recommendation = selectRecommendedNext({
    state, skillsById, questionsById, questionData, domainCode,
    // A deliberate domain switch must not let an old-domain active path take
    // precedence over the requested domain.
    currentSkillId: currentDomain && currentDomain !== domainCode ? false : current?.skillId ?? null
  });
  return {
    selectedQuestionId: recommendation.selectedQuestionId,
    fromPending: false,
    recommendation,
    safeExit: recommendation.safeExit
  };
}

function explainRoute({ action, correct, choice, skill, targetSkill, relationship, masteryChange, selectorReasonCategory = 'authored-route' }) {
  if (correct) {
    if (selectorReasonCategory === 'freshness-replacement') return 'Your answer was correct. A fresh question will continue the next step without repeating a problem you already answered.';
    if (selectorReasonCategory === 'blocking-prerequisite') return 'Your answer was correct. Before the next idea, a prerequisite foundation needs more evidence, so the next problem starts there.';
    if (selectorReasonCategory === 'forward-target-handoff') return 'Your answer was correct. The next step needs a quick teacher check-in before continuing.';
    if (selectorReasonCategory === 'no-fresh-forward-question') return 'Your answer was correct. There is not a fresh next question here, so this path is pausing instead of repeating work.';
    if (selectorReasonCategory === 'no-fresh-transfer-question') return 'Your answer was correct. There is not a fresh transfer question here, so this path is pausing instead of repeating work.';
    if (action === 'TRANSFER') return 'Independent success supports a move to a harder transfer task.';
    if (action === 'ADVANCE') return `The response adds positive evidence for ${skill.studentName} and supports moving forward.`;
    if (action === 'RETRY') return 'The idea is correct; a fresh problem will confirm that the success transfers.';
  }
  if (choice.feedback) return choice.feedback;
  if (action === 'DIAGNOSE') {
    return `The response suggests ${choice.evidence?.misconceptionLabel ?? 'a specific uncertainty'}, so the next item will test that hypothesis before any regression.`;
  }
  if (action === 'REGRESS') {
    return `The diagnostic produced evidence of a blocking ${relationship ?? 'prerequisite'}${targetSkill ? `: ${targetSkill.studentName}` : ''}.`;
  }
  if (action === 'REMEDIATE') return 'A small targeted intervention is appropriate before a fresh retry.';
  if (action === 'REVIEW') return `Recent evidence for ${skill.studentName} conflicts, so the system will collect another independent response rather than relabel mastery immediately.`;
  if (action === 'TEACHER_INTERVENTION') return 'This path is pausing so you can get a quick check-in before choosing what to practice next.';
  return masteryChange.scoreDelta < 0
    ? 'The response lowers confidence slightly, but it does not erase earlier evidence.'
    : 'The next item will gather additional evidence.';
}

function hasAttemptedQuestion(state, questionId) {
  return state.attempts.some(attempt => attempt.questionId === questionId);
}

function chooseSafeAlternateQuestion({ question, state, questionsById, allowIntervention = false }) {
  const roleOrder = new Map([
    ['remediation', 0],
    ['recovery', 1],
    ['diagnostic', 2],
    ['practice', 3],
    ['diagnostic-entry', 4]
  ]);
  return [...questionsById.values()]
    .filter(candidate => candidate.skillId === question.skillId && candidate.id !== question.id && !hasAttemptedQuestion(state, candidate.id) &&
      roleOrder.has(candidate.role) && (allowIntervention || !['remediation', 'recovery'].includes(candidate.role)))
    .sort((left, right) => roleOrder.get(left.role) - roleOrder.get(right.role) || left.id.localeCompare(right.id))[0] ?? null;
}

function resolveBoundedRoute({ question, correct, configured, state, questionsById }) {
  const configuredAction = configured?.action ?? (correct ? 'ADVANCE' : 'RETRY');
  const configuredNextQuestionId = configured?.nextQuestionId ?? null;

  if (configuredAction === 'TEACHER_INTERVENTION') {
    return {
      action: 'TEACHER_INTERVENTION',
      nextQuestionId: null,
      safeExit: { reason: 'teacher-intervention-route', skillId: question.skillId }
    };
  }

  // A wrong answer may revisit a diagnostic task, but it may not repeatedly
  // route the student to an already attempted question. A fresh same-skill
  // item is preferred; when none remains, stop safely instead of cycling.
  const repeatsAttemptedQuestion = !correct && configuredNextQuestionId &&
    (configuredNextQuestionId === question.id || hasAttemptedQuestion(state, configuredNextQuestionId));
  if (!repeatsAttemptedQuestion) {
    return { action: configuredAction, nextQuestionId: configuredNextQuestionId, safeExit: null };
  }

  const alternate = chooseSafeAlternateQuestion({ question, state, questionsById,
    allowIntervention: ['REMEDIATE', 'REGRESS', 'DIAGNOSE'].includes(configuredAction) });
  if (alternate) {
    return { action: 'REMEDIATE', nextQuestionId: alternate.id, safeExit: null };
  }
  return {
    action: 'TEACHER_INTERVENTION',
    nextQuestionId: null,
    safeExit: { reason: 'no-fresh-same-skill-question', skillId: question.skillId }
  };
}

function guardForwardRoute({ question, boundedRoute, configured, state, skillsById, questionsById }) {
  if (!['ADVANCE', 'TRANSFER'].includes(boundedRoute.action)) return { ...boundedRoute, authoredTargetAccepted: null, authoredTargetOverridden: false, blockerSkillId: null, reasonCategory: 'authored-route' };
  const authoredQuestion = boundedRoute.nextQuestionId ? questionsById.get(boundedRoute.nextQuestionId) : null;
  const targetSkillId = authoredQuestion?.skillId ?? configured?.targetSkillId ?? question.skillId;
  const targetSkill = skillsById.get(targetSkillId);
  if (!targetSkill || targetSkill.handoff) {
    return {
      action: 'TEACHER_INTERVENTION', nextQuestionId: null,
      safeExit: { reason: 'forward-target-handoff', skillId: normalizeSkillId(question.skillId) },
      authoredTargetAccepted: false, authoredTargetOverridden: true, blockerSkillId: normalizeSkillId(targetSkillId), reasonCategory: 'forward-target-handoff'
    };
  }
  const readiness = assessReadiness(targetSkill, state, skillsById, questionsById);
  if (readiness?.verified) {
    // A completed authored exit may sit inside a legitimate prerequisite fan-out.
    // Continue only through the reverse-connected lineage of the active skill,
    // never by scanning globally mastered sources from another journey/domain.
    if (!boundedRoute.nextQuestionId && skillIsMastered(state, targetSkill, questionsById)) {
      const journeyId=targetSkill.frontierJourney ?? targetSkill.frontierJourneyId;
      const lineage = new Set([targetSkill.id]), pending=[targetSkill.id];
      while(pending.length){const currentId=pending.pop();for(const source of skillsById.values())if((source.successors??[]).includes(currentId)&&hasEvidenceForSkill(state,source.id)&&!lineage.has(source.id)){lineage.add(source.id);pending.push(source.id);}}
      const hasRootFanout = Boolean(journeyId) && [...lineage].some(sourceId => { const source=skillsById.get(sourceId); return (source?.frontierJourney ?? source?.frontierJourneyId)===journeyId && (source?.requiredPrerequisites??[]).length===0 && (source?.successors??[]).length>1 && state.attempts.some(attempt=>attempt.attemptedSkill===sourceId&&questionsById.get(attempt.questionId)?.role==='diagnostic-entry'); });
      const currentDomainCode=targetSkill.metadata?.domainCode ?? authoredQuestion?.metadata?.domainCode ?? question.metadata?.domainCode ?? null;
      const frontier = hasRootFanout ? [...skillsById.values()].filter(candidate =>
        (candidate.frontierJourney ?? candidate.frontierJourneyId)===journeyId && !candidate.handoff &&
        (candidate.metadata?.domainCode ?? null)===currentDomainCode && !skillIsMastered(state, candidate, questionsById) &&
        [...lineage].some(sourceId => (skillsById.get(sourceId)?.successors ?? []).includes(candidate.id))
      ).sort((left, right) => left.id.localeCompare(right.id)) : [];
      for (const candidate of frontier) {
        const candidateReadiness = assessReadiness(candidate, state, skillsById, questionsById);
        if (!candidateReadiness?.verified) continue;
        const fresh = freshQuestionsForSkill({ skillId: candidate.id, state, questionsById })[0];
        if (fresh) return {
          action: 'ADVANCE', nextQuestionId: fresh.id, safeExit: null,
          authoredTargetAccepted: false, authoredTargetOverridden: true, blockerSkillId: null,
          targetReadiness: candidateReadiness, reasonCategory: 'ready-frontier-continuation'
        };
      }
    }
    const authoredAlreadyAttempted = boundedRoute.nextQuestionId && hasAttemptedQuestion(state, boundedRoute.nextQuestionId);
    if (!authoredAlreadyAttempted) return { ...boundedRoute, authoredTargetAccepted: true, authoredTargetOverridden: false, blockerSkillId: null, targetReadiness: readiness, reasonCategory: 'authored-route' };
    const stateAfterCurrent = { ...state, attempts: [...state.attempts, { questionId: question.id }] };
    const fresh = boundedRoute.action === 'TRANSFER'
      ? freshTransferQuestionsForSkill({ skillId: targetSkillId, state: stateAfterCurrent, questionsById,
        domainCode: authoredQuestion?.metadata?.domainCode ?? question.metadata?.domainCode })[0]
      : freshQuestionsForSkill({ skillId: targetSkillId, state: stateAfterCurrent, questionsById,
        domainCode: authoredQuestion?.metadata?.domainCode ?? question.metadata?.domainCode })[0];
    if (fresh) return {
      action: boundedRoute.action, nextQuestionId: fresh.id, safeExit: null,
      authoredTargetAccepted: false, authoredTargetOverridden: true, blockerSkillId: null, targetReadiness: readiness, reasonCategory: 'freshness-replacement'
    };
    return {
      action: 'TEACHER_INTERVENTION', nextQuestionId: null,
      safeExit: { reason: boundedRoute.action === 'TRANSFER' ? 'no-fresh-transfer-question' : 'no-fresh-forward-question', skillId: normalizeSkillId(targetSkillId) },
      authoredTargetAccepted: false, authoredTargetOverridden: true, blockerSkillId: null, targetReadiness: readiness,
      reasonCategory: boundedRoute.action === 'TRANSFER' ? 'no-fresh-transfer-question' : 'no-fresh-forward-question'
    };
  }
  const blocker = firstBlockingPrerequisite(targetSkill, state, skillsById, questionsById, authoredQuestion?.metadata?.domainCode ?? question.metadata?.domainCode);
  if (blocker?.questionId) return {
    action: 'REGRESS', nextQuestionId: blocker.questionId, safeExit: null,
    authoredTargetAccepted: false, authoredTargetOverridden: true, blockerSkillId: blocker.skillId, targetReadiness: readiness, reasonCategory: 'blocking-prerequisite'
  };
  return {
    action: 'TEACHER_INTERVENTION', nextQuestionId: null,
    safeExit: { reason: blocker?.handoff ? 'blocking-prerequisite-handoff' : 'no-fresh-blocking-prerequisite', skillId: normalizeSkillId(targetSkillId) },
    authoredTargetAccepted: false, authoredTargetOverridden: true, blockerSkillId: normalizeSkillId(blocker?.skillId) ?? normalizeSkillId(targetSkillId), targetReadiness: readiness,
    reasonCategory: blocker?.handoff ? 'forward-target-handoff' : 'blocking-prerequisite'
  };
}

export function evaluateResponse({ question, choiceId, state, skillsById, questionsById, hintLevel = 0 }) {
  const skill = skillsById.get(question.skillId);
  if (!skill) throw new Error(`Question references unknown skill: ${question.skillId}`);
  const choice = question.choices.find(item => item.id === choiceId);
  if (!choice) throw new Error(`Unknown choice ${choiceId} for question ${question.id}`);

  const masteryChange = updateMastery({
    state,
    skill,
    question,
    correct: choice.correct,
    hintLevel
  });
  // Route selection follows a submitted response, so it may use this one
  // fully described response as evidence. It is not the merely-open
  // currentQuestionId and is persisted in full below before the state leaves
  // this function.
  const routingState = {
    ...state,
    attempts: [...state.attempts, {
      attemptedSkill: skill.id,
      questionId: question.id,
      correct: choice.correct,
      assistance: { hintLevel, independent: hintLevel === 0 },
      masteryEvidenceChange: masteryChange
    }]
  };
  const { action: configuredAction, configured } = chooseAction({ question, choice, state, skill, correct: choice.correct });
  const boundedRoute = resolveBoundedRoute({
    question,
    correct: choice.correct,
    configured: { ...configured, action: configuredAction },
    state,
    questionsById
  });
  const guardedRoute = guardForwardRoute({ question, boundedRoute, configured, state: routingState, skillsById, questionsById });
  const action = guardedRoute.action;
  const nextQuestionId = guardedRoute.nextQuestionId;
  const nextQuestion = nextQuestionId ? questionsById.get(nextQuestionId) : null;
  if (nextQuestionId && !nextQuestion) throw new Error(`Route references unknown question: ${nextQuestionId}`);

  // Reporting must describe the route the learner will actually take after
  // loop protection, not the original authored target that was bypassed.
  const targetSkillId = nextQuestion?.skillId ?? null;
  const targetSkill = targetSkillId ? skillsById.get(targetSkillId) : null;
  const relationship = relationshipFor(skill, choice.evidence?.prerequisiteSkillId ?? targetSkillId);
  const targetReadiness = guardedRoute.targetReadiness ?? assessReadiness(targetSkill, routingState, skillsById, questionsById);

  const evidence = {
    attemptedSkill: skill.id,
    questionId: question.id,
    correct: choice.correct,
    correctness: choice.correct,
    misconceptionEvidence: (choice.evidence?.kind === 'misconception-hypothesis' || choice.evidence?.misconceptionId) ? [{
      kind: choice.evidence?.kind ?? 'misconception-hypothesis',
      confidence: choice.evidence.confidence ?? 'medium'
    }] : [],
    prerequisiteEvidence: choice.evidence?.prerequisiteSkillId ? {
      skillId: choice.evidence.prerequisiteSkillId,
      relationship: relationshipFor(skill, choice.evidence.prerequisiteSkillId),
      confidence: choice.evidence.confidence ?? 'medium'
    } : null,
    errorType: choice.evidence?.kind === 'generic-error' ? 'generic-error' : choice.evidence?.errorType ?? null,
    assistance: { hintLevel, independent: hintLevel === 0 },
    masteryEvidenceChange: masteryChange,
    recommendedNextAction: action,
    recommendedNextSkill: targetSkillId,
    recommendedNextQuestion: nextQuestionId,
    safeExit: guardedRoute.safeExit,
    targetReadiness,
    selectorAudit: {
      selectedQuestionId: nextQuestionId,
      selectedSkillId: targetSkillId,
      safeAction: action,
      readiness: targetReadiness,
      reasonCategory: guardedRoute.reasonCategory,
      authoredTargetAccepted: guardedRoute.authoredTargetAccepted,
      authoredTargetOverridden: guardedRoute.authoredTargetOverridden,
      blockerSkillId: guardedRoute.blockerSkillId,
      handoff: Boolean(guardedRoute.safeExit?.reason?.includes('handoff')),
      safeExit: guardedRoute.safeExit
    },
    explanation: explainRoute({
      action,
      correct: choice.correct,
      choice,
      skill,
      targetSkill,
      relationship,
      masteryChange,
      selectorReasonCategory: guardedRoute.reasonCategory
    })
  };

  state.attempts.push(evidence);
  state.currentQuestionId = nextQuestionId;
  state.safeExit = guardedRoute.safeExit;
  state.hintLevel = 0;
  return evidence;
}

export function overallProgress(state, skills, questionsById = null) {
  const relevant = skills.filter(skill => !skill.handoff);
  if (!relevant.length) return 0;
  const total = relevant.reduce((sum, skill) => {
    const status = getSkillStatus(state, skill, questionsById);
    return sum + Math.max(0, STATUS.indexOf(status));
  }, 0);
  return Math.round((total / (relevant.length * (STATUS.length - 1))) * 100);
}

/**
 * Return the only student-facing mastery status the engine recognizes.  This
 * deliberately treats incomplete, malformed, and forged saved records as
 * unassessed rather than letting an arbitrary string reach the UI.
 */
export function getSkillStatus(state, skill, questionsById = null) {
  if (!skill || skill.handoff) return 'Not Assessed';
  const record = state?.mastery?.[skill.id];
  if (!hasCanonicalEvidenceShape(record) || !hasVerifiedEvidenceReferences(state, skill, record, questionsById)) return 'Not Assessed';
  const derived = deriveStatus(record, skill.masteryEvidence);
  if (isEngineRetainedMasteryAfterOneContradiction(state, skill, record, skill.masteryEvidence)) return 'Mastered';
  // The engine can intentionally retain a lower recorded state after repeated
  // contradictory evidence. Never let a display recomputation undo that
  // safeguard, while still downgrading impossible optimistic claims.
  return STATUS.indexOf(record.status) <= STATUS.indexOf(derived) ? record.status : derived;
}

export function isSavedStateCompatible(state, questionsById, skillsById = null) {
  if (
    !state || typeof state !== 'object' ||
    !Array.isArray(state.attempts) ||
    !state.mastery || typeof state.mastery !== 'object' || Array.isArray(state.mastery)
  ) return false;
  if (state.safeExit !== undefined && state.safeExit !== null && (
    !state.safeExit || typeof state.safeExit !== 'object' || Array.isArray(state.safeExit) ||
      typeof state.safeExit.reason !== 'string' || !state.safeExit.reason ||
      (state.safeExit.skillId !== null && (typeof state.safeExit.skillId !== 'string' || !state.safeExit.skillId))
  )) return false;
  if (state.pendingQuestionIds !== undefined && (
    !state.pendingQuestionIds || typeof state.pendingQuestionIds !== 'object' || Array.isArray(state.pendingQuestionIds) ||
    Object.entries(state.pendingQuestionIds).some(([domainCode, questionId]) =>
      !ASSESSED_DOMAIN_CODES.has(domainCode) || typeof questionId !== 'string' ||
      questionsById.get(questionId)?.metadata?.domainCode !== domainCode)
  )) return false;
  // An unanswered question can only retain assistance that its exported,
  // bounded hint set could actually have revealed.  Reject impossible saved
  // levels rather than silently changing the evidence carried into an answer.
  // Older compatible records did not always serialize an untouched zero.  An
  // absent value is therefore the same as no hint, while any explicit value
  // must meet the bounded current-release contract.
  const savedHintLevel = state.hintLevel ?? 0;
  if (!Number.isInteger(savedHintLevel) || savedHintLevel < 0 || savedHintLevel > 3) return false;
  if (typeof state.currentQuestionId === 'string') {
    const currentQuestion = questionsById.get(state.currentQuestionId);
    const hintCount = Array.isArray(currentQuestion?.hints)
      ? currentQuestion.hints.filter(hint => typeof hint === 'string' && hint.trim()).slice(0, 3).length
      : (typeof currentQuestion?.hint === 'string' && currentQuestion.hint.trim() ? 1 : 0);
    if (!currentQuestion || savedHintLevel > hintCount) return false;
  }
  for (const [skillId, record] of Object.entries(state.mastery)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (!STATUS.includes(record.status)) return false;
    const skill = skillsById?.get(skillId);
    if (record.status !== 'Not Assessed' && (!skill || getSkillStatus(state, skill, questionsById) !== record.status)) return false;
    if (record.status === 'Not Assessed' && !hasCanonicalEvidenceShape(record)) return false;
  }
  if (state.currentQuestionId === null) return state.attempts.length > 0 || Boolean(state.safeExit);
  return typeof state.currentQuestionId === 'string' && questionsById.has(state.currentQuestionId);
}

export function loadCompatibleSavedState({ storage, primaryKey, legacyKeys = [], questionsById, skillsById = null }) {
  const read = key => {
    try {
      const parsed = JSON.parse(storage.getItem(key));
      return isSavedStateCompatible(parsed, questionsById, skillsById) ? parsed : null;
    } catch {
      return null;
    }
  };
  const current = read(primaryKey);
  if (current) return current;
  for (const legacyKey of legacyKeys) {
    const legacy = read(legacyKey);
    if (!legacy) continue;
    storage.setItem(primaryKey, JSON.stringify(legacy));
    return legacy;
  }
  return null;
}
