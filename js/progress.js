import { getSkillStatus, SKILL_STATUSES } from './engine.js';

export const TSIA2_DOMAINS = Object.freeze([
  { code: 'QR', name: 'Quantitative Reasoning', description: 'Percent, ratio, rate, and proportional reasoning practice.' },
  { code: 'AR', name: 'Algebraic Reasoning', description: 'Equations, functions, exponents, and exponential-relationship practice.' },
  { code: 'GSR', name: 'Geometric and Spatial Reasoning', description: 'Area, volume, and right-triangle practice with clear visual supports.' },
  { code: 'PSR', name: 'Probabilistic and Statistical Reasoning', description: 'Read frequency and data displays, compare center and spread, use weighted means, and reason about simple and conditional probability.' }
]);

// These labels use only already-exported student-safe metadata.  The mapping
// prevents eight identical "Linear Equations" labels from becoming ambiguous
// without exposing private graph IDs or authoring terminology.
const SAFE_SUBSKILL_LABELS = Object.freeze({
  'one-step-addition-and-subtraction': 'One-step equations: add or subtract',
  'one-step-multiplication-and-division': 'One-step equations: multiply or divide',
  'two-step-equations': 'Two-step equations',
  'distribution-in-equations': 'Equations with distribution',
  'combining-like-terms-in-equations': 'Equations with like terms',
  'variables-on-both-sides': 'Equations with variables on both sides',
  'fraction-and-decimal-equations': 'Equations with fractions or decimals',
  'contextual-and-solution-check-equations': 'Write and check equations from situations'
});

export function safeStudentSkillName(skill) {
  const subskill = skill?.metadata?.subskill;
  return SAFE_SUBSKILL_LABELS[subskill] ?? skill?.studentName ?? 'Math skill';
}

export function buildDomainProgress({ state, skills = [], questions = [] }) {
  const releasedSkills = skills.filter(skill => skill && !skill.handoff);
  const questionsById = new Map(questions.filter(question => question?.id).map(question => [question.id, question]));
  return TSIA2_DOMAINS.map(domain => {
    const domainSkills = releasedSkills.filter(skill => skill.metadata?.domainCode === domain.code);
    const questionCount = questions.filter(question => question?.metadata?.domainCode === domain.code).length;
    const statusCounts = Object.fromEntries(SKILL_STATUSES.map(status => [status, 0]));
    const skillRows = domainSkills.map(skill => {
      const status = getSkillStatus(state, skill, questionsById);
      statusCounts[status] += 1;
      return { name: safeStudentSkillName(skill), status };
    });
    const assessedSkills = domainSkills.length - statusCounts['Not Assessed'];
    const masteredSkills = statusCounts.Mastered;
    const inProgressSkills = assessedSkills - masteredSkills;
    const available = domainSkills.length > 0 && questionCount > 0;
    const learnerState = !available
      ? 'not-assessed'
      : assessedSkills === 0
        ? 'not-assessed'
        : masteredSkills === domainSkills.length
          ? 'all-released-skills-mastered'
          : 'in-progress';
    return {
      ...domain,
      available,
      coverage: { skills: domainSkills.length, questions: questionCount },
      learner: { assessedSkills, masteredSkills, inProgressSkills, statusCounts, state: learnerState },
      skills: skillRows
    };
  });
}

const domainCodes = new Set(TSIA2_DOMAINS.map(domain => domain.code));

// This is intentionally separate from mastery. It describes completed
// questions in their saved order; it does not calculate a readiness score or
// change what the adaptive engine chooses next.
export function buildGrowthSummary({ state, questions = [] }) {
  const questionsById = new Map(
    questions
      .filter(question => question?.id && domainCodes.has(question.metadata?.domainCode))
      .map(question => [question.id, question])
  );
  const byDomain = new Map(TSIA2_DOMAINS.map(domain => [domain.code, {
    code: domain.code,
    questionsTried: 0,
    correctWithoutHints: 0,
    questionsWithHelp: 0,
    independentAttempts: 0,
    trend: 'more-practice-needed'
  }]));

  const validAttempts = (Array.isArray(state?.attempts) ? state.attempts : [])
    .flatMap(attempt => {
      const question = questionsById.get(attempt?.questionId);
      const hintLevel = attempt?.assistance?.hintLevel;
      if (!question || typeof attempt?.correct !== 'boolean' || !Number.isInteger(hintLevel) || hintLevel < 0 || hintLevel > 3) return [];
      return [{ domainCode: question.metadata.domainCode, correct: attempt.correct, hintLevel }];
    });

  const independentByDomain = new Map(TSIA2_DOMAINS.map(domain => [domain.code, []]));
  for (const attempt of validAttempts) {
    const summary = byDomain.get(attempt.domainCode);
    summary.questionsTried += 1;
    if (attempt.hintLevel > 0) summary.questionsWithHelp += 1;
    if (attempt.hintLevel === 0) {
      summary.independentAttempts += 1;
      independentByDomain.get(attempt.domainCode).push(attempt.correct);
      if (attempt.correct) summary.correctWithoutHints += 1;
    }
  }

  for (const domain of TSIA2_DOMAINS) {
    const summary = byDomain.get(domain.code);
    const independent = independentByDomain.get(domain.code);
    // Four independent attempts gives two equally sized, ordered windows. A
    // trend is withheld until there is enough of the student's own work to
    // make that comparison useful.
    if (independent.length < 4) continue;
    const midpoint = Math.floor(independent.length / 2);
    const earlier = independent.slice(0, midpoint);
    const recent = independent.slice(midpoint);
    const rate = entries => entries.filter(Boolean).length / entries.length;
    const change = rate(recent) - rate(earlier);
    summary.trend = change >= 0.25
      ? 'improving'
      : change <= -0.25
        ? 'needs-focus'
        : 'steady';
  }

  return {
    domains: TSIA2_DOMAINS.map(domain => byDomain.get(domain.code)),
    questionsTried: validAttempts.length,
    correctWithoutHints: validAttempts.filter(attempt => attempt.hintLevel === 0 && attempt.correct).length,
    questionsWithHelp: validAttempts.filter(attempt => attempt.hintLevel > 0).length
  };
}
