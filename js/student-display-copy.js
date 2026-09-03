// The bank remains the private instructional record. This display-only layer
// removes a small, known set of authoring wrappers before text reaches a
// student. It never chooses, supplies, or changes a mathematical answer.
const asText = value => typeof value === 'string' ? value : '';

export function studentPromptCopy(value) {
  return asText(value)
    .replace(/\bWhich statement (?:is|gives|provides) the best evidence that\b/gi, 'Which statement best shows that');
}

function withoutRepeatedPrompt(value, prompt) {
  const source = asText(value).trim();
  const exactPrompt = asText(prompt).trim();
  if (exactPrompt) {
    for (const prefix of [`In “${exactPrompt}”,`, `In "${exactPrompt}",`]) {
      if (source.startsWith(prefix)) return source.slice(prefix.length).trim();
    }
  }
  return source.replace(/^In [“"][\s\S]+?[”"],\s*/u, '');
}

function cleanInstruction(value) {
  return asText(value)
    .replace(/^focus on calculate\b/i, 'Focus on calculating')
    .replace(/^focus on identify\b/i, 'Focus on identifying')
    .replace(/^focus on interpret\b/i, 'Focus on interpreting')
    .replace(/^focus on compare\b/i, 'Focus on comparing')
    .replace(/^focus on solve\b/i, 'Focus on solving')
    .replace(/^focus on use\b/i, 'Focus on using')
    .replace(/^focus on find\b/i, 'Focus on finding')
    .replace(/^focus on write\b/i, 'Focus on writing')
    .replace(/^focus on determine\b/i, 'Focus on determining')
    .replace(/^focus on evaluate\b/i, 'Focus on evaluating')
    .replace(/^focus on recognize\b/i, 'Focus on recognizing')
    .replace(/\.{2,}$/u, '.');
}

export function studentFeedbackCopy(value, prompt = '') {
  const source = studentPromptCopy(value);
  const wrapped = source.match(/^In [“"](.+)[”"],\s*check the exact claim [“"](.+)[”"]\s+(using|against)\s+(.+);\s*this (?:is|remains) a same-skill retry because (?:(?:its|the) )?cause is not uniquely established\.?$/i);
  if (wrapped) {
    const method = wrapped[4].replace(/[.?!]+$/u, '');
    return `Check whether your answer matches ${method}. Try another problem with the same idea.`;
  }
  const instruction = withoutRepeatedPrompt(source, prompt);
  const diagnosisWrapper = instruction.match(/^[“"][\s\S]+?[”"]\s+points to\s+[^.]+\.\s*(.+)$/i);
  if (diagnosisWrapper) return cleanInstruction(`Next, ${diagnosisWrapper[1]}`);
  return cleanInstruction(withoutRepeatedPrompt(source
    .replace(/;\s*this (?:is|remains) a same-skill retry because (?:(?:its|the) )?cause is not uniquely established\.?$/i, '. Try another problem with the same idea.')
    .replace(/\bThis is a same-skill retry\.?/gi, 'Try another problem with the same idea.')
    .replace(/;\s*One answer is not enough evidence[^.]*\.?/gi, '. Keep practicing this idea with another problem.')
    .replace(/\bOne answer is not enough evidence[^.]*\.?/gi, 'Keep practicing this idea with another problem.'), prompt));
}

export function studentHintCopy(value, prompt = '') {
  return cleanInstruction(withoutRepeatedPrompt(studentPromptCopy(value), prompt));
}
