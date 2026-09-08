// The starting check is a local instructional baseline. It is intentionally
// separate from an official TSIA2 administration or score. The question list
// is derived deterministically from the currently exported practice bank so a
// student can safely resume the exact same check after a reload.

export const STARTING_CHECK_DOMAIN_COUNTS = Object.freeze({ QR: 6, AR: 7, GSR: 3, PSR: 4 });
export const STARTING_CHECK_TOTAL = Object.values(STARTING_CHECK_DOMAIN_COUNTS).reduce((sum, count) => sum + count, 0);
const DOMAIN_CODES = Object.freeze(Object.keys(STARTING_CHECK_DOMAIN_COUNTS));
const QUESTION_ROLES = new Set(['diagnostic-entry', 'diagnostic', 'practice', 'independent', 'transfer']);
const roleRank = new Map([['diagnostic-entry', 0], ['diagnostic', 1], ['practice', 2], ['independent', 3], ['transfer', 4]]);

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validTimestamp(value) { return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)); }
function stableNumber(text) {
  let hash = 2166136261;
  for (const character of String(text)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}
function questionIsEligible(question, domainCode) {
  return isRecord(question) && typeof question.id === 'string' && question.id &&
    question.metadata?.domainCode === domainCode && QUESTION_ROLES.has(question.role) &&
    typeof question.skillId === 'string' && question.skillId && Array.isArray(question.choices) &&
    question.choices.length >= 2 && question.choices.some(choice => choice?.correct === true) &&
    question.choices.every(choice => typeof choice?.id === 'string' && choice.id && typeof choice?.correct === 'boolean');
}

function orderedCandidates(questions, domainCode, seed) {
  return questions.filter(question => questionIsEligible(question, domainCode)).sort((left, right) => {
    const byForm = stableNumber(`${seed}|${left.id}`) - stableNumber(`${seed}|${right.id}`);
    return byForm || (roleRank.get(left.role) ?? 99) - (roleRank.get(right.role) ?? 99) || left.id.localeCompare(right.id);
  });
}

// Pick one form per skill before taking a second form. This avoids quietly
// concentrating a short check on a single skill when the exported bank has
// more distinct skill coverage available.
function chooseDomainQuestions(candidates, needed) {
  const selected = [];
  const chosenIds = new Set();
  for (let round = 0; selected.length < needed; round += 1) {
    let selectedThisRound = 0;
    const seenSkills = new Set();
    for (const question of candidates) {
      if (selected.length >= needed) break;
      if (chosenIds.has(question.id) || seenSkills.has(question.skillId)) continue;
      const priorForms = selected.filter(item => item.skillId === question.skillId).length;
      if (priorForms !== round) continue;
      selected.push(question); chosenIds.add(question.id); seenSkills.add(question.skillId); selectedThisRound += 1;
    }
    if (selectedThisRound === 0) break;
  }
  return selected;
}

export function selectStartingCheckQuestionIds({ questions = [], questionVersion = '' } = {}) {
  if (!Array.isArray(questions) || typeof questionVersion !== 'string' || !questionVersion) return null;
  const selected = [];
  for (const domainCode of DOMAIN_CODES) {
    const choices = chooseDomainQuestions(orderedCandidates(questions, domainCode, `starting-check-v1|${questionVersion}|${domainCode}`), STARTING_CHECK_DOMAIN_COUNTS[domainCode]);
    if (choices.length !== STARTING_CHECK_DOMAIN_COUNTS[domainCode]) return null;
    selected.push(...choices);
  }
  return selected.map(question => question.id);
}

export function createStartingCheck({ questions = [], questionVersion = '', now = new Date().toISOString(), attemptCountAtStart = 0 } = {}) {
  const questionIds = selectStartingCheckQuestionIds({ questions, questionVersion });
  if (!questionIds || !validTimestamp(now) || !Number.isInteger(attemptCountAtStart) || attemptCountAtStart < 0) return null;
  return {
    version: 1,
    status: 'in-progress',
    questionVersion,
    questionIds,
    index: 0,
    responses: [],
    startedAt: now,
    // This immutable boundary keeps old ordinary practice out of the Day 1
    // comparison. Starting-check responses are separate and never enter the
    // ordinary attempt journal.
    attemptCountAtStart
  };
}

function domainTotals(questionIds, questionsById) {
  const totals = Object.fromEntries(DOMAIN_CODES.map(code => [code, 0]));
  for (const questionId of questionIds) {
    const code = questionsById.get(questionId)?.metadata?.domainCode;
    if (!DOMAIN_CODES.includes(code)) return null;
    totals[code] += 1;
  }
  return Object.entries(STARTING_CHECK_DOMAIN_COUNTS).every(([code, count]) => totals[code] === count) ? totals : null;
}

function deriveBaseline(check, questionsById) {
  const domains = Object.fromEntries(DOMAIN_CODES.map(code => [code, { correct: 0, total: STARTING_CHECK_DOMAIN_COUNTS[code] }]));
  for (const response of check.responses) {
    const code = questionsById.get(response.questionId)?.metadata?.domainCode;
    if (!domains[code]) return null;
    if (response.correct) domains[code].correct += 1;
  }
  return { totalCorrect: check.responses.filter(response => response.correct).length, totalQuestions: STARTING_CHECK_TOTAL, domains };
}

export function sanitizeStartingCheck(value, { questionsById, questionVersion } = {}) {
  if (!isRecord(value) || !(questionsById instanceof Map) || typeof questionVersion !== 'string' || !questionVersion ||
    value.version !== 1 || !['in-progress', 'complete'].includes(value.status) || value.questionVersion !== questionVersion ||
    !Array.isArray(value.questionIds) || value.questionIds.length !== STARTING_CHECK_TOTAL ||
    new Set(value.questionIds).size !== STARTING_CHECK_TOTAL || !value.questionIds.every(questionId => typeof questionId === 'string' && questionsById.has(questionId)) ||
    !Number.isInteger(value.index) || value.index < 0 || value.index > STARTING_CHECK_TOTAL ||
    !Array.isArray(value.responses) || value.responses.length !== value.index || !validTimestamp(value.startedAt) ||
    !Number.isInteger(value.attemptCountAtStart) || value.attemptCountAtStart < 0) return null;
  const expected = selectStartingCheckQuestionIds({ questions: [...questionsById.values()], questionVersion });
  if (!expected || expected.length !== value.questionIds.length || expected.some((questionId, index) => questionId !== value.questionIds[index]) || !domainTotals(value.questionIds, questionsById)) return null;
  const responses = [];
  for (let index = 0; index < value.responses.length; index += 1) {
    const response = value.responses[index];
    if (!isRecord(response) || response.questionId !== value.questionIds[index] || typeof response.correct !== 'boolean' || !validTimestamp(response.answeredAt)) return null;
    responses.push({ questionId: response.questionId, correct: response.correct, answeredAt: response.answeredAt });
  }
  if (value.status === 'in-progress' && value.index >= STARTING_CHECK_TOTAL) return null;
  if (value.status === 'complete' && value.index !== STARTING_CHECK_TOTAL) return null;
  const safe = { version: 1, status: value.status, questionVersion, questionIds: [...value.questionIds], index: value.index, responses, startedAt: value.startedAt, attemptCountAtStart: value.attemptCountAtStart };
  if (value.status === 'complete') {
    if (!validTimestamp(value.completedAt) || !isRecord(value.baseline)) return null;
    const baseline = deriveBaseline(safe, questionsById);
    if (!baseline || value.baseline.totalCorrect !== baseline.totalCorrect || value.baseline.totalQuestions !== STARTING_CHECK_TOTAL ||
      DOMAIN_CODES.some(code => value.baseline.domains?.[code]?.correct !== baseline.domains[code].correct || value.baseline.domains?.[code]?.total !== baseline.domains[code].total)) return null;
    safe.completedAt = value.completedAt;
    safe.baseline = baseline;
  }
  return safe;
}

export function activeStartingCheck(state) { return state?.startingCheck?.status === 'in-progress' ? state.startingCheck : null; }
export function currentStartingCheckQuestionId(state) { const check = activeStartingCheck(state); return check ? check.questionIds[check.index] ?? null : null; }

export function recordStartingCheckResponse(state, { questionId, correct, now = new Date().toISOString(), questionsById } = {}) {
  const check = activeStartingCheck(state);
  if (!check || check.questionIds[check.index] !== questionId || typeof correct !== 'boolean' || !validTimestamp(now)) return null;
  check.responses.push({ questionId, correct, answeredAt: now });
  check.index += 1;
  if (check.index < STARTING_CHECK_TOTAL) return { complete: false, nextQuestionId: check.questionIds[check.index] };
  const baseline = deriveBaseline(check, questionsById);
  if (!baseline) return null;
  check.status = 'complete'; check.completedAt = now; check.baseline = baseline;
  return { complete: true, nextQuestionId: null, baseline };
}

// A tie keeps the published domain order. This is deliberately conservative:
// it chooses where normal adaptive practice should begin, not a claim that a
// lower raw count diagnoses a particular prerequisite or mastery level.
export function startingCheckRecommendedDomain(state) {
  const baseline = state?.startingCheck?.status === 'complete' ? state.startingCheck.baseline : null;
  if (!isRecord(baseline?.domains)) return null;
  let selected = null;
  for (const code of DOMAIN_CODES) {
    const summary = baseline.domains[code];
    if (!isRecord(summary) || !Number.isInteger(summary.correct) || !Number.isInteger(summary.total) || summary.total < 1) return null;
    if (!selected || (summary.correct / summary.total) < (selected.correct / selected.total)) selected = { code, ...summary };
  }
  return selected?.code ?? null;
}

function validLaterIndependentAttempt(attempt, questionsById) {
  const question = questionsById.get(attempt?.questionId);
  return question && DOMAIN_CODES.includes(question.metadata?.domainCode) && attempt?.startingCheck !== true &&
    typeof attempt?.correct === 'boolean' && attempt?.assistance?.hintLevel === 0 && attempt?.assistance?.independent === true;
}

export function buildDayOneGrowth(state, { questionsById, minimumIndependentAttempts = 3 } = {}) {
  const check = state?.startingCheck;
  if (!check || check.status !== 'complete' || !isRecord(check.baseline) || !(questionsById instanceof Map)) return null;
  const safeMinimum = Number.isInteger(minimumIndependentAttempts) && minimumIndependentAttempts >= 1 && minimumIndependentAttempts <= 20 ? minimumIndependentAttempts : 3;
  const domains = Object.fromEntries(DOMAIN_CODES.map(code => [code, {
    baselineCorrect: check.baseline.domains?.[code]?.correct ?? 0,
    baselineTotal: check.baseline.domains?.[code]?.total ?? STARTING_CHECK_DOMAIN_COUNTS[code],
    laterCorrect: 0, laterIndependentAttempts: 0, minimumIndependentAttempts: safeMinimum
  }]));
  // Only ordinary attempts written after the baseline began may be compared.
  // The count is saved in the baseline record, so a pre-existing journal entry
  // cannot quietly become Day 1 growth evidence after a reload.
  const attempts = (state?.attempts ?? []).slice(check.attemptCountAtStart);
  for (const attempt of attempts) {
    if (!validLaterIndependentAttempt(attempt, questionsById)) continue;
    const summary = domains[questionsById.get(attempt.questionId).metadata.domainCode];
    summary.laterIndependentAttempts += 1;
    if (attempt.correct) summary.laterCorrect += 1;
  }
  return { completedAt: check.completedAt, totalCorrect: check.baseline.totalCorrect, totalQuestions: STARTING_CHECK_TOTAL, domains };
}

export function dayOneComparisonCopy(summary) {
  if (!summary) return 'Complete the starting check to create a Day 1 reference point.';
  if (summary.laterIndependentAttempts < summary.minimumIndependentAttempts) return `Day 1: ${summary.baselineCorrect} of ${summary.baselineTotal} correct. Answer ${summary.minimumIndependentAttempts - summary.laterIndependentAttempts} more new problem${summary.minimumIndependentAttempts - summary.laterIndependentAttempts === 1 ? '' : 's'} on your own before comparing.`;
  return `Day 1: ${summary.baselineCorrect} of ${summary.baselineTotal} correct. Later practice: ${summary.laterCorrect} of ${summary.laterIndependentAttempts} correct without hints.`;
}
