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
  // Routing explanations are internal records; translate their known templates
  // at the display boundary without changing the saved record or the route.
  const routeCopy = [
    [/^Your answer was correct\. Before the next idea, a prerequisite foundation needs more evidence, so the next problem starts there\.$/, 'Your answer is correct. Next, try a short question on an idea you will use later.'],
    [/^Independent success supports a move to a harder transfer task\.$/, 'You solved that on your own. Try using the idea in a new situation.'],
    [/^The response adds positive evidence for .+ and supports moving forward\.$/, 'Your answer is correct. You are ready for the next idea.'],
    [/^The idea is correct; a fresh problem will confirm that the success transfers\.$/, 'That idea is correct. Try it with a different problem.'],
    [/^The response suggests .+, so the next item will test that hypothesis before any regression\.$/, 'Try a short question to work out which part needs more practice.'],
    [/^The diagnostic produced evidence of a blocking .+\.$/, 'Let’s work on a smaller step that will help with this problem.'],
    [/^A small targeted intervention is appropriate before a fresh retry\.$/, 'Let’s try one small step, then another problem.'],
    [/^Recent evidence for .+ conflicts, so the system will collect another independent response rather than relabel mastery immediately\.$/, 'Try another problem on your own to see how comfortable you feel with this idea.'],
    [/^The response lowers confidence slightly, but it does not erase earlier evidence\.$/, 'This answer does not undo your earlier work. Keep practicing this idea.'],
    [/^The next item will gather additional evidence\.$/, 'Try another problem to keep building this skill.'],
    [/^Your answer was correct\. There is not a fresh transfer question here, so this path is pausing instead of repeating work\.$/, 'Your answer is correct. You have tried the available questions for this step. Choose another area or check in with your teacher.']
  ];
  for (const [pattern, copy] of routeCopy) if (pattern.test(source)) return copy;
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
