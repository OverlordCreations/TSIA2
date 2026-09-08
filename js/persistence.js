import { attemptFields, validAttemptAcknowledgement, validAttemptProposal, opaqueQuestionId, opaqueSkillId } from './attempt-contract.js';
import { sanitizeStartingCheck } from './starting-check.js';
const migrationVersion = 'v3';
const envelopeVersion = 1;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function memoryStorage() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }; }
export function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
export function createSafeStorage(storage) {
  if (storage?.__tsia2SafeStorage === true) return storage;
  const fallback = memoryStorage(); let available = Boolean(storage); let fallbackReported = false;
  const run = (operation, fallbackOperation) => { if (available) { try { return operation(storage); } catch { available = false; } } return fallbackOperation(fallback); };
  return Object.freeze({ __tsia2SafeStorage: true, getItem: key => run(store => store.getItem(key), store => store.getItem(key)), setItem: (key, value) => run(store => store.setItem(key, value), store => store.setItem(key, value)), removeItem: key => run(store => store.removeItem(key), store => store.removeItem(key)), consumeFallbackNotice: () => { if (available || fallbackReported) return false; fallbackReported = true; return true; }, get usingMemoryFallback() { return !available; } });
}

const scope = ({ questionVersion, releaseId = 'unbound' }) => `v${encodeURIComponent(String(questionVersion))}-r${encodeURIComponent(String(releaseId))}`;
export function keysForIdentity({ questionVersion, releaseId = 'unbound', uid = null }) {
  const suffix = uid ? `-uid-${uid}` : '';
  const versionScope = scope({ questionVersion, releaseId });
  return { state: `tsia2-math-practice-state-${versionScope}${suffix}`, queue: `tsia2-math-practice-queue-${versionScope}${suffix}`, attemptTransaction: `tsia2-math-practice-attempt-transaction-${versionScope}${suffix}`, migration: `tsia2-math-practice-migration-${migrationVersion}-${versionScope}${suffix}`, legacyState: `tsia2-percent-phase1-state-${questionVersion}`, legacyUnscopedState: `tsia2-math-practice-state-v${questionVersion}${suffix}`, corruptQueue: `tsia2-math-practice-queue-corrupt-${versionScope}${suffix}`, issues: `tsia2-math-practice-queue-issues-${versionScope}${suffix}` };
}

const validIsoTimestamp = value => typeof value === 'string' && value.length >= 20 && value.length <= 32 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
function sanitizeRecord(value, questionVersion, releaseId) { if (!isRecord(value)||!validAttemptProposal(value.proposal)||value.proposal.releaseId!==releaseId||!isRecord(value.localContext)||value.localContext.questionVersion!==questionVersion||(value.localContext.skillId!==null&&!opaqueSkillId(value.localContext.skillId))||!['QR','AR','GSR','PSR',null].includes(value.localContext.domainCode)||typeof value.localContext.questionRole!=='string'||!value.localContext.questionRole||typeof value.localContext.difficulty!=='string'||!value.localContext.difficulty||!Number.isInteger(value.attempts)||value.attempts<0||!validIsoTimestamp(value.queuedAt)||(value.lastAttemptAt!=null&&!validIsoTimestamp(value.lastAttemptAt))||(value.nextRetryAt!=null&&!validIsoTimestamp(value.nextRetryAt))||(value.localContext.occurredAtClient!=null&&!validIsoTimestamp(value.localContext.occurredAtClient))||(value.blocked!==undefined&&typeof value.blocked!=='boolean')) return null; return {proposal:{eventId:value.proposal.eventId,sessionId:value.proposal.sessionId,releaseId:value.proposal.releaseId,questionId:value.proposal.questionId,choiceId:value.proposal.choiceId},localContext:{questionVersion,graphVersion:typeof value.localContext.graphVersion==='string'?value.localContext.graphVersion:null,domainCode:value.localContext.domainCode,skillId:value.localContext.skillId,questionRole:value.localContext.questionRole,difficulty:value.localContext.difficulty,occurredAtClient:value.localContext.occurredAtClient??null},localPreview:{authoritative:false,correctness:typeof value.localPreview?.correctness==='boolean'?value.localPreview.correctness:null,assistanceAuthority:'unknown-unverified'},queuedAt:value.queuedAt,attempts:value.attempts,lastAttemptAt:value.lastAttemptAt??null,nextRetryAt:value.nextRetryAt??null,blocked:value.blocked===true}; }
function validRecord(value) { return value!==null; }
function proposalFingerprint(proposal) { return attemptFields.map(key => `${key}:${proposal[key]}`).join('|'); }
function digest128(text) { let a=2166136261,b=0x9e3779b9,c=0x85ebca6b,d=0xc2b2ae35; for (let i=0;i<text.length;i+=1) { const x=text.charCodeAt(i); a=Math.imul(a^x,16777619); b=Math.imul(b^x,2246822519); c=Math.imul(c^x,3266489917); d=Math.imul(d^x,668265263); } return [a,b,c,d].map(x=>(x>>>0).toString(16).padStart(8,'0')).join(''); }
export const proposalPayloadHash = proposal => attemptFields.map(field => `${field}:${proposal[field].length}:${proposal[field]}`).join('|');
export function validAcknowledgementFor(record, acknowledgement) {
  return isRecord(record) && validAttemptProposal(record.proposal) && validAttemptAcknowledgement(acknowledgement, { eventId: record.proposal.eventId, proposalHash: proposalPayloadHash(record.proposal) });
}

export function createPersistence({ storage, safeStorage, questionVersion, releaseId = 'unbound', uid = null }) {
  const sharedStorage = createSafeStorage(safeStorage ?? storage); const keys = keysForIdentity({ questionVersion, releaseId, uid }); const expectedOwner = uid ?? null;
  const notices = new Set();
  const readJson = key => { const text = sharedStorage.getItem(key); if (text === null) return { value: null, absent: true, malformed: false }; try { const value = JSON.parse(text); return { value, absent: false, explicitNull:value === null, malformed: false }; } catch { return { value: null, absent: false, malformed: true, fingerprint: digest128(text) }; } };
  const writeJson = (key, value) => sharedStorage.setItem(key, JSON.stringify(value));
  const readStateRaw = () => { const parsed = readJson(keys.state); const value = parsed.value; if (parsed.malformed || parsed.explicitNull) { notices.add('saved-state-rejected'); return null; } if (parsed.absent) return null; if (!isRecord(value)) { notices.add('saved-state-rejected'); return null; } if (value.schemaVersion === envelopeVersion && value.ownerUid === expectedOwner && isRecord(value.state)) return value.state; if (expectedOwner === null && value.schemaVersion === undefined) return value; notices.add('saved-state-rejected'); return null; };
  const quarantine = (reason, fingerprint = null, count = null) => writeJson(keys.corruptQueue, { quarantinedAt: new Date().toISOString(), reason, fingerprint, count });
  const readQueue = () => { const parsed = readJson(keys.queue); const value = parsed.value; if (parsed.malformed) { notices.add('attempt-queue-rejected'); quarantine('malformed-json', parsed.fingerprint); writeJson(keys.queue, []); return []; } if (parsed.explicitNull) { notices.add('attempt-queue-rejected'); quarantine('explicit-json-null'); writeJson(keys.queue, []); return []; } if (parsed.absent) return []; if (!Array.isArray(value)) { notices.add('attempt-queue-rejected'); quarantine('not-array'); writeJson(keys.queue, []); return []; } const valid=value.map(record=>sanitizeRecord(record,questionVersion,releaseId)).filter(validRecord); if (valid.length!==value.length) { notices.add('attempt-queue-rejected'); quarantine('invalid-or-stale-records',null,value.length-valid.length); } if(JSON.stringify(valid)!==JSON.stringify(value)) writeJson(keys.queue,valid); return valid; };
  const sanitizeQueue = queue => Array.isArray(queue) ? queue.map(record => sanitizeRecord(record, questionVersion, releaseId)).filter(validRecord) : [];
  const enqueue = record => { const safe = sanitizeRecord(record, questionVersion, releaseId); if (!safe) throw new Error('Invalid queued attempt record.'); const queue = readQueue(); const existing = queue.find(item => item.proposal.eventId === safe.proposal.eventId); if (existing) { if (proposalFingerprint(existing.proposal) !== proposalFingerprint(safe.proposal)) { const error = new Error('Conflicting attempt event ID.'); error.code = 'queue-conflict'; throw error; } return queue; } queue.push(safe); writeJson(keys.queue, queue); return queue; };
  const writeState = state => writeJson(keys.state, { schemaVersion: envelopeVersion, ownerUid: expectedOwner, state });
  const validTransaction = value => isRecord(value) && value.schemaVersion === envelopeVersion && value.ownerUid === expectedOwner && isRecord(value.state) && sanitizeRecord(value.record, questionVersion, releaseId) !== null;
  const recoverPendingAttempt = () => {
    const parsed = readJson(keys.attemptTransaction);
    if (parsed.malformed || parsed.explicitNull || (!parsed.absent && parsed.value !== null && !validTransaction(parsed.value))) {
      notices.add('attempt-queue-rejected');
      if (parsed.explicitNull) quarantine('attempt-journal-explicit-json-null');
      try { sharedStorage.removeItem(keys.attemptTransaction); } catch { /* Retain nothing untrusted in the UI. */ }
      return null;
    }
    if (parsed.value === null) return null;
    const transaction = parsed.value;
    try {
      enqueue(transaction.record);
      writeState(transaction.state);
      sharedStorage.removeItem(keys.attemptTransaction);
      return transaction.state;
    } catch {
      return null;
    }
  };
  const readState = () => recoverPendingAttempt() ?? readStateRaw();
  const commitAttemptAndState = (record, state) => {
    const safe = sanitizeRecord(record, questionVersion, releaseId);
    if (!safe || !isRecord(state)) throw new Error('Invalid local attempt transaction.');
    writeJson(keys.attemptTransaction, { schemaVersion: envelopeVersion, ownerUid: expectedOwner, record: safe, state });
    enqueue(safe);
    writeState(state);
    sharedStorage.removeItem(keys.attemptTransaction);
    return { queue: readQueue(), state };
  };
  const readPriorVersionState = priorVersion => {
    if (priorVersion !== '0.9.0') return null;
    const priorKey = `tsia2-math-practice-state-v${priorVersion}${uid ? `-uid-${uid}` : ''}`;
    const parsed = readJson(priorKey); const value = parsed.value;
    if (!isRecord(value)) return null;
    const raw = value.schemaVersion === envelopeVersion && value.ownerUid === expectedOwner && isRecord(value.state) ? value.state : (expectedOwner === null ? value : null);
    return sanitizeLegacyState(raw);
  };
  return { storage: sharedStorage, keys, uid, readState, readPriorVersionState, reportNotice: kind => { if (['saved-state-rejected','attempt-queue-rejected'].includes(kind)) notices.add(kind); }, consumeNotices: () => { if (sharedStorage.consumeFallbackNotice?.()) notices.add('memory-fallback'); const result = [...notices]; notices.clear(); return result; }, writeState, readQueue, writeQueue: queue => writeJson(keys.queue, sanitizeQueue(queue)),
    enqueue,
    commitAttemptAndState,
    recoverPendingAttempt,
    hasPendingAttempt: () => readJson(keys.attemptTransaction).value !== null,
    markAttempt: eventId => { const queue = readQueue().map(item => item.proposal.eventId === eventId ? { ...item, attempts: item.attempts + 1, lastAttemptAt: new Date().toISOString() } : item); writeJson(keys.queue, queue); return queue; },
    markTransient: eventId => { const now=Date.now(); const queue = readQueue().map(item => item.proposal.eventId === eventId ? { ...item, attempts: item.attempts + 1, lastAttemptAt: new Date(now).toISOString(), nextRetryAt: new Date(now + retryDelayMs(item.attempts + 1)).toISOString() } : item); writeJson(keys.queue, queue); return queue; },
    acknowledge: (record, acknowledgement) => { const queue=readQueue(); const current=queue.find(item=>item.proposal.eventId===record?.proposal?.eventId); if (!current || proposalFingerprint(current.proposal)!==proposalFingerprint(record.proposal) || !validAcknowledgementFor(current, acknowledgement)) return queue; const next = queue.filter(item => item.proposal.eventId !== current.proposal.eventId); writeJson(keys.queue, next); return next; },
    recordIssue: (record, code) => { const queue=readQueue(); const current=queue.find(item=>item.proposal.eventId===record?.proposal?.eventId); if (!current || proposalFingerprint(current.proposal)!==proposalFingerprint(record.proposal)) return queue; const issues = readJson(keys.issues).value; const next = Array.isArray(issues) ? issues : []; next.push({ eventId: current.proposal.eventId, code, retained: true, recordedAt: new Date().toISOString() }); writeJson(keys.issues, next); const retained=queue.map(item=>item.proposal.eventId===current.proposal.eventId?{...item,blocked:true}:item); writeJson(keys.queue,retained); return retained; },
    blockPendingAttempts: () => { const queue=readQueue(); const issues = readJson(keys.issues).value; const nextIssues = Array.isArray(issues) ? issues : []; const retained = queue.map(item => { if (item.blocked) return item; nextIssues.push({ eventId:item.proposal.eventId, code:'session-invalid', retained:true, recordedAt:new Date().toISOString() }); return { ...item, blocked:true }; }); writeJson(keys.issues, nextIssues); writeJson(keys.queue, retained); return retained; },
    quarantineConflict: (record, code = 'already-exists') => { const queue=readQueue(); const current=queue.find(item=>item.proposal.eventId===record?.proposal?.eventId); if (!current || proposalFingerprint(current.proposal)!==proposalFingerprint(record.proposal)) return queue; const issues = readJson(keys.issues).value; const next = Array.isArray(issues) ? issues : []; next.push({ eventId: current.proposal.eventId, code, conflict: true, recordedAt: new Date().toISOString() }); writeJson(keys.issues, next); const retained=queue.map(item => item.proposal.eventId === current.proposal.eventId ? { ...item, blocked: true } : item); writeJson(keys.queue, retained); return retained; },
    getMigration: () => readJson(keys.migration).value, setMigration: receipt => writeJson(keys.migration, receipt), findLegacyState: () => readJson(keys.legacyState).value, findUnscopedState: () => readJson(keys.legacyUnscopedState).value, transferQueueFrom: source => { const receipt={ migrated:0, conflicts:0, skipped:0 }; for (const record of source.readQueue()) { if (record.proposal.releaseId !== releaseId || record.localContext?.questionVersion !== questionVersion) { receipt.skipped+=1; continue; } try { const before=readQueue().length; enqueue(record); const after=readQueue().length; receipt.migrated += after>before?1:0; } catch { receipt.conflicts+=1; } } return receipt; }, usingMemoryFallback: () => sharedStorage.usingMemoryFallback };
}

export function createEventId(random = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) { return random ? random() : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
export function createAttemptProposal({ eventId = createEventId(), sessionId, releaseId, question, choiceId }) { if (!sessionId || !releaseId || !question?.id || !choiceId) throw new Error('A complete local attempt proposal requires session, release, question, and choice identifiers.'); return Object.freeze({ eventId, sessionId, releaseId, questionId: question.id, choiceId }); }
export function localAttemptRecord(proposal, evidence, masteryBefore, masteryAfter, localContext = {}) { return { proposal, localContext: { questionVersion: localContext.questionVersion ?? 'unknown', graphVersion: localContext.graphVersion ?? null, domainCode: localContext.domainCode ?? null, skillId: localContext.skillId ?? null, questionRole: localContext.questionRole ?? 'unknown', difficulty: localContext.difficulty ?? 'unknown', occurredAtClient: localContext.occurredAtClient ?? new Date().toISOString() }, localPreview: { authoritative: false, correctness: evidence.correctness, recommendedNextAction: evidence.recommendedNextAction ?? null, masteryBefore: masteryBefore ?? null, masteryAfter: masteryAfter ?? null, assistanceAuthority: 'unknown-unverified' }, queuedAt: new Date().toISOString(), attempts: 0 }; }
export const retryDelayMs = attempts => Math.min(30000, 1000 * (2 ** Math.min(5, Math.max(0, attempts))));
export function studentSafePersistenceNoticeCopy(notices) {
  const received = new Set(Array.isArray(notices) ? notices : []);
  const messages = [];
  if (received.has('memory-fallback')) messages.push('This browser cannot save locally right now. Practice will continue until this tab closes.');
  if (received.has('saved-state-rejected')) messages.push('A saved practice record on this device could not be used, so practice started safely fresh.');
  if (received.has('attempt-queue-rejected')) messages.push('A saved attempt record on this device could not be used, so it will not be sent. Practice can continue.');
  return messages.join(' ');
}
export function mergeStudentSafeStatusCopy(notice, statusCopy) {
  const safeNotice = typeof notice === 'string' ? notice.trim() : '';
  const safeStatus = typeof statusCopy === 'string' ? statusCopy.trim() : '';
  return [safeNotice, safeStatus].filter(Boolean).join(' ');
}
export function clearStudentNoticeForIdentity(currentUid, nextUid, notice) {
  return currentUid === nextUid && typeof notice === 'string' ? notice : '';
}

// A lease makes a stale asynchronous answer or hint completion harmless after
// an identity change. It carries no student data and is deliberately local.
export function createInteractionLease() {
  let current = null; let sequence = 0;
  return Object.freeze({
    begin: kind => {
      if (current || typeof kind !== 'string' || !kind) return null;
      current = Object.freeze({ kind, token: ++sequence });
      return current;
    },
    release: lease => {
      if (!current || !lease || current.token !== lease.token) return false;
      current = null;
      return true;
    },
    clear: () => { const previous = current; current = null; sequence += 1; return previous; },
    get current() { return current; }
  });
}
export function studentSafeSyncStatusCopy({ signedIn = false, pending = false, blocked = 0, retrying = 0, transient = false, sessionInvalid = false } = {}) {
  if (!signedIn) return 'Local practice is available on this device.';
  if (pending) return 'Checking saved attempts for this signed-in account…';
  const safeBlocked = Number.isInteger(blocked) && blocked > 0 ? blocked : 0;
  const safeRetrying = Number.isInteger(retrying) && retrying > 0 ? retrying : 0;
  if (sessionInvalid && safeBlocked) return `Your sign-in needs to be refreshed before ${safeBlocked} saved attempt${safeBlocked === 1 ? '' : 's'} can sync. Sign out, then sign in again, or keep practicing on this device.`;
  if (sessionInvalid) return 'Your sign-in needs to be refreshed before saved attempts can sync. Sign out, then sign in again, or keep practicing on this device.';
  if (safeBlocked && transient && safeRetrying) return `${safeBlocked} saved attempt${safeBlocked === 1 ? '' : 's'} need${safeBlocked === 1 ? 's' : ''} a later check-in, and ${safeRetrying} other attempt${safeRetrying === 1 ? '' : 's'} will retry when connection returns. Local practice is still available.`;
  if (safeBlocked) return `${safeBlocked} saved attempt${safeBlocked === 1 ? '' : 's'} need${safeBlocked === 1 ? 's' : ''} a later check-in before syncing. Local practice is still available.`;
  if (transient || safeRetrying) return 'Saved attempts are waiting to sync when connection returns. Local practice is still available.';
  return 'Saved attempts are up to date for this session.';
}
export function migrationId({ uid, questionVersion, legacyState }) { const snapshot = JSON.stringify(legacyState ?? null); let hash = 2166136261; for (let index = 0; index < snapshot.length; index += 1) hash = Math.imul(hash ^ snapshot.charCodeAt(index), 16777619); return `legacy-${migrationVersion}-${uid}-${questionVersion}-${(hash >>> 0).toString(16)}`; }
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000;
const status = new Set(['Not Assessed','Emerging','Developing','Near Mastery','Mastered']);
export function sanitizeLegacyState(value, { questionsById = null, questionVersion = null } = {}) {
  if (!isRecord(value) || !Array.isArray(value.attempts) || !isRecord(value.mastery) || (value.currentQuestionId !== null && !opaqueQuestionId(value.currentQuestionId))) return null;
  const validHint = value => Number.isInteger(value) && value >= 0 && value <= 3;
  const mastery={};
  for (const [id, record] of Object.entries(value.mastery)) {
    if (!opaqueSkillId(id) || !isRecord(record) || !Number.isFinite(record.score) || record.score < 0 || record.score > 10 ||
      !['independentCorrect','assistedCorrect','incorrect','transferCorrect'].every(key => Number.isInteger(record[key]) && record[key] >= 0) ||
      !Array.isArray(record.distinctCorrectQuestions) || !record.distinctCorrectQuestions.every(opaqueQuestionId) || new Set(record.distinctCorrectQuestions).size !== record.distinctCorrectQuestions.length ||
      !Array.isArray(record.recent) || !record.recent.every(item => isRecord(item) && opaqueQuestionId(item.questionId) && typeof (item.correct ?? item.correctness) === 'boolean' && validHint(item.hintLevel)) ||
      typeof record.needsIndependentAfterHighHint !== 'boolean' || !status.has(record.status)) return null;
    mastery[id]={ score:record.score, independentCorrect:record.independentCorrect, assistedCorrect:record.assistedCorrect, incorrect:record.incorrect, transferCorrect:record.transferCorrect,
      distinctCorrectQuestions:[...record.distinctCorrectQuestions], recent:record.recent.map(item=>({ questionId:item.questionId, correct:item.correct ?? item.correctness, hintLevel:item.hintLevel })),
      needsIndependentAfterHighHint:record.needsIndependentAfterHighHint, status:record.status };
  }
  const attempts=[];
  for (const item of value.attempts) {
    const attemptedSkill=item?.attemptedSkill ?? item?.skillId; const correct=item?.correct ?? item?.correctness; const hintLevel=item?.assistance?.hintLevel ?? item?.hintLevel;
    if (!isRecord(item) || !opaqueQuestionId(item.questionId) || !opaqueSkillId(attemptedSkill) || typeof correct !== 'boolean' || !validHint(hintLevel) ||
      (item.startingCheck !== undefined && item.startingCheck !== true) ||
      (item.assistance !== undefined && (!isRecord(item.assistance) || (item.assistance.independent !== undefined && item.assistance.independent !== (hintLevel === 0))))) return null;
    attempts.push({ questionId:item.questionId, attemptedSkill, correct, assistance:{ hintLevel, independent:hintLevel===0 }, ...(item.startingCheck === true ? { startingCheck:true } : {}) });
  }
  if (attempts.length > 1000) return null;
  const result={ currentQuestionId:value.currentQuestionId, mastery, attempts, hintLevel:Number.isInteger(value.hintLevel)&&value.hintLevel>=0&&value.hintLevel<=3?value.hintLevel:0, safeExit:null };
  if (isRecord(value.pendingQuestionIds)) { const pending={}; for (const domain of ['QR','AR','GSR','PSR']) if (opaqueQuestionId(value.pendingQuestionIds[domain])) pending[domain]=value.pendingQuestionIds[domain]; if (Object.keys(pending).length) result.pendingQuestionIds=pending; }
  if (isRecord(value.safeExit) && (value.safeExit.skillId===null||opaqueSkillId(value.safeExit.skillId))) result.safeExit={reason:'legacy-local-check-in',skillId:value.safeExit.skillId??null};
  if (typeof value.sessionStartedAt==='string' && value.sessionStartedAt.length<=40 && !Number.isNaN(Date.parse(value.sessionStartedAt))) result.sessionStartedAt=value.sessionStartedAt;
  if (value.startingCheck !== undefined) {
    const startingCheck = sanitizeStartingCheck(value.startingCheck, { questionsById, questionVersion });
    if (!startingCheck) return null;
    if (startingCheck.status === 'in-progress' && (result.hintLevel !== 0 || result.currentQuestionId !== startingCheck.questionIds[startingCheck.index])) return null;
    result.startingCheck = startingCheck;
  }
  return result;
}
export function prepareLegacyMigration({ uid, questionVersion, legacyState, questionsById = null }) { const sanitized = sanitizeLegacyState(legacyState, { questionsById, questionVersion }); if (!uid || !sanitized) return null; const snapshotFingerprint=digest128(JSON.stringify(sanitized)); return Object.freeze({ migrationId: migrationId({ uid, questionVersion, legacyState: sanitized }), snapshotFingerprint, uid, questionVersion, requiresExplicitConsent: true, authoritative: false, missingFields: ['choiceId', 'occurredAtClient', 'misconceptionId'], status: 'awaiting-consent', legacyState: sanitized }); }
