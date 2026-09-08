// Student-safe, bounded progressive-hint behavior. Content is already
// allowlisted by the private export; repeated clicks reveal authored guidance.
const fallback = 'Name the quantities and the relationship between them before calculating.';

export function hintsForQuestion(question) {
  const hints = Array.isArray(question?.hints) ? question.hints : [];
  const safe = hints.filter(hint => typeof hint === 'string' && hint.trim().length > 0 && hint.length <= 500);
  return safe.length ? safe.slice(0, 3) : [typeof question?.hint === 'string' && question.hint.trim() ? question.hint : fallback];
}

export function nextHint(question, currentLevel = 0) {
  const hints = hintsForQuestion(question);
  const prior = Number.isInteger(currentLevel) && currentLevel >= 0 ? currentLevel : 0;
  const level = Math.min(hints.length, prior + 1);
  return { level, text:hints[level - 1], hasMore:level < hints.length };
}

// Rendering an already-saved hint is deliberately separate from revealing a
// new one.  A reload must restore the exact assistance level without moving
// it forward or producing another hint-use event.
export function revealedHint(question, savedLevel = 0) {
  const hints = hintsForQuestion(question);
  if (!Number.isInteger(savedLevel) || savedLevel < 1 || savedLevel > hints.length) return null;
  return { level:savedLevel, text:hints[savedLevel - 1], hasMore:savedLevel < hints.length };
}
