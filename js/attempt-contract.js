export const attemptFields = Object.freeze(['eventId', 'sessionId', 'releaseId', 'questionId', 'choiceId']);
// Public-safe receipt shapes shared by the browser and the private callable.
export const authoritativeContractVersion = '1';
export const attemptAcknowledgementFields = Object.freeze(['contractVersion','eventId','accepted','authoritativeReceipt','proposalHash','correctness','nextAction','assistanceAuthority','evidenceClassification','masteryAuthoritative']);
export const sessionAcknowledgementFields = Object.freeze(['contractVersion','sessionId','questionId','accepted','authoritativeSession']);
export const hintAcknowledgementFields = Object.freeze(['contractVersion','hintEventId','accepted','authoritativeHintReceipt','assistanceAuthority']);
export const attemptIdentifierPattern = '^[A-Za-z0-9._:-]{1,160}$';
export const forbiddenAttemptIdentifiers = Object.freeze(['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']);
export function validAttemptIdentifier(value) { return typeof value === 'string' && new RegExp(attemptIdentifierPattern).test(value) && !forbiddenAttemptIdentifiers.includes(value); }
export const opaqueQuestionId = value => /^q\d{3,}$/.test(value ?? '');
export const opaqueChoiceId = value => /^[a-z]$/.test(value ?? '');
export const opaqueSkillId = value => /^(s|x)\d{3,}$/.test(value ?? '');
export function validAttemptProposal(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === attemptFields.length && Object.keys(value).every(key => attemptFields.includes(key)) && validAttemptIdentifier(value.eventId) && validAttemptIdentifier(value.sessionId) && validAttemptIdentifier(value.releaseId) && opaqueQuestionId(value.questionId) && opaqueChoiceId(value.choiceId); }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, fields) => record(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
export function validAttemptAcknowledgement(value, { eventId, proposalHash, correctness = null, nextAction = undefined } = {}) {
  return exactKeys(value, attemptAcknowledgementFields) && value.contractVersion === authoritativeContractVersion && value.eventId === eventId && value.accepted === true && value.authoritativeReceipt === true && value.proposalHash === proposalHash && typeof value.correctness === 'boolean' && (correctness === null || value.correctness === correctness) && (value.nextAction === null || typeof value.nextAction === 'string') && (nextAction === undefined || value.nextAction === nextAction) && value.assistanceAuthority === 'server-recomputed' && ['assisted','unknown'].includes(value.evidenceClassification) && value.masteryAuthoritative === false;
}
export function validSessionAcknowledgement(value, { sessionId, questionId } = {}) {
  return exactKeys(value, sessionAcknowledgementFields) && value.contractVersion === authoritativeContractVersion && value.sessionId === sessionId && value.questionId === questionId && value.accepted === true && value.authoritativeSession === true;
}
export function validHintAcknowledgement(value, { hintEventId } = {}) {
  return exactKeys(value, hintAcknowledgementFields) && value.contractVersion === authoritativeContractVersion && value.hintEventId === hintEventId && value.accepted === true && value.authoritativeHintReceipt === true && value.assistanceAuthority === 'server-recorded-hint';
}
