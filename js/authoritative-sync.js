import { attemptFields, validAttemptProposal } from './attempt-contract.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => record(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fingerprint = proposal => attemptFields.map(field => `${field}:${proposal[field]}`).join('|');
const actions = new Set(['ADVANCE', 'RETRY', 'DIAGNOSE', 'REGRESS', 'REMEDIATE', 'TRANSFER', 'REVIEW', 'TEACHER_INTERVENTION']);
const statuses = new Set(['Provisional — evidence unverifiable', 'Provisional — mastery rule not approved']);
const MAX_PROGRESS_COUNTER = 1_000_000;
const validatedMergeBrand = new WeakSet();

function trusted(value) {
  const skills = value?.skillDomains; const question = value?.hasQuestion;
  return record(skills) && Object.keys(skills).length > 0 && Object.entries(skills).every(([key, domain]) => /^(s|x)\d{3,}$/.test(key) && ['QR','AR','GSR','PSR'].includes(domain)) && typeof question === 'function' ? Object.freeze({ skills: Object.freeze({ ...skills }), question }) : null;
}
function validProgress(value, trust) {
  return exact(value, ['skillId','domainCode','totalReceipts','correctReceipts','incorrectReceipts','assistedCorrect','unknownEvidence','status','masteryAuthoritative']) && trust.skills[value.skillId] === value.domainCode && [value.totalReceipts,value.correctReceipts,value.incorrectReceipts,value.assistedCorrect,value.unknownEvidence].every(count=>Number.isSafeInteger(count)&&count>=0&&count<=MAX_PROGRESS_COUNTER) && value.correctReceipts + value.incorrectReceipts === value.totalReceipts && value.assistedCorrect <= value.correctReceipts && value.unknownEvidence <= value.totalReceipts && value.assistedCorrect + value.unknownEvidence <= value.totalReceipts && statuses.has(value.status) && value.status === (value.unknownEvidence > 0 ? 'Provisional — evidence unverifiable' : 'Provisional — mastery rule not approved') && value.masteryAuthoritative === false;
}
function event(value, uid, releaseId, trust) {
  if (!exact(value, ['eventId','sessionId','releaseId','questionId','choiceId','authoritative','receivedAt','correct','evidenceClassification']) || !validAttemptProposal({eventId:value.eventId,sessionId:value.sessionId,releaseId:value.releaseId,questionId:value.questionId,choiceId:value.choiceId}) || value.releaseId !== releaseId || value.authoritative !== true || !timestamp(value.receivedAt) || typeof value.correct !== 'boolean' || !['assisted','unknown'].includes(value.evidenceClassification) || trust.question(value.questionId) !== true) return null;
  return Object.freeze({ ...value, proposal: Object.freeze({eventId:value.eventId,sessionId:value.sessionId,releaseId:value.releaseId,questionId:value.questionId,choiceId:value.choiceId}) });
}
const validCursor = value => value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,1200}$/.test(value));

// Only the callable's exact, bounded envelope is accepted. Browser projections
// cannot become cloud authority; remote data never mutates the engine or queue.
export function sanitizeAuthoritativeSnapshot(value, { uid, releaseId, trustedRelease }) {
  const trust = trusted(trustedRelease);
  if (!trust || !exact(value, ['schemaVersion','uid','releaseId','asOf','events','progress','resume','nextCursor']) || value.schemaVersion !== 1 || value.uid !== uid || value.releaseId !== releaseId || !timestamp(value.asOf) || !Array.isArray(value.events) || value.events.length > 100 || !record(value.progress) || Object.keys(value.progress).length > Object.keys(trust.skills).length || !validCursor(value.nextCursor) || !exact(value.resume, ['mode','sourceEvent','nextAction'])) return null;
  if (value.resume.mode === 'none' && (value.resume.sourceEvent !== null || value.resume.nextAction !== null)) return null;
  const source = value.resume.mode === 'post-attempt' ? event(value.resume.sourceEvent, uid, releaseId, trust) : null;
  if (value.resume.mode === 'post-attempt' && (!source || Date.parse(source.receivedAt)>Date.parse(value.asOf) || !(value.resume.nextAction === null || actions.has(value.resume.nextAction)))) return null;
  if (!['none','post-attempt'].includes(value.resume.mode)) return null;
  const events=[]; const seen=new Set(); let prior=null;
  for (const raw of value.events) { const safe=event(raw,uid,releaseId,trust); if (!safe || seen.has(safe.eventId) || (prior && (safe.receivedAt < prior.receivedAt || (safe.receivedAt === prior.receivedAt && safe.eventId <= prior.eventId))) || Date.parse(safe.receivedAt) > Date.parse(value.asOf)) return null; seen.add(safe.eventId); events.push(safe); prior=safe; }
  const progress=Object.create(null); for (const [key,item] of Object.entries(value.progress)) { if (key !== item?.skillId || !validProgress(item,trust) || Object.hasOwn(progress,key)) return null; progress[key]=Object.freeze({...item}); }
  if (source && events.some(item=>item.eventId===source.eventId && JSON.stringify(item)!==JSON.stringify(source))) return null;
  return Object.freeze({schemaVersion:1,uid,releaseId,asOf:value.asOf,events:Object.freeze(events),progress:Object.freeze(progress),resume:Object.freeze({mode:value.resume.mode,sourceEvent:source,nextAction:value.resume.nextAction}),nextCursor:value.nextCursor});
}

export function mergeAuthoritativeSnapshot({ uid, releaseId, trustedRelease, localRecords = [], remoteSnapshot, localUnansweredQuestion = null }) {
  const trust = trusted(trustedRelease); const remote = sanitizeAuthoritativeSnapshot(remoteSnapshot,{uid,releaseId,trustedRelease}); const events=[]; const seen=new Map(); const quarantined=[];
  const add=(source,raw)=>{ const proposal=raw?.proposal??raw; if (!validAttemptProposal(proposal)||proposal.releaseId!==releaseId) {quarantined.push(`${source}-malformed`);return;} const hash=fingerprint(proposal); const prior=seen.get(proposal.eventId); const current=Object.freeze({proposal:Object.freeze({...proposal}),source,authoritative:source==='remote'}); if (prior&&prior.hash!==hash){quarantined.push(`${source}-conflict`);return;} if (!prior){seen.set(proposal.eventId,{hash,index:events.length,source});events.push(current);return;} if (source==='remote'&&prior.source==='local'){events[prior.index]=current;seen.set(proposal.eventId,{...prior,source:'remote'});} };
  for (const item of Array.isArray(localRecords)?localRecords:[]) add('local',item); if(remote) for(const item of remote.events)add('remote',item); else if(remoteSnapshot!=null)quarantined.push('remote-foreign-or-malformed-snapshot');
  const local = exact(localUnansweredQuestion,['schemaVersion','releaseId','questionId']) && localUnansweredQuestion.schemaVersion===1 && localUnansweredQuestion.releaseId===releaseId && trust?.question(localUnansweredQuestion.questionId)===true ? Object.freeze({questionId:localUnansweredQuestion.questionId,source:'local-unanswered'}) : null;
  const candidate=local??(remote?.resume.mode==='post-attempt'&&trust?.question(remote.resume.sourceEvent.questionId)===true?Object.freeze({questionId:remote.resume.sourceEvent.questionId,sourceEventId:remote.resume.sourceEvent.eventId,nextAction:remote.resume.nextAction,source:'remote-post-attempt'}):null);
  const result=Object.freeze({uid,releaseId,events:Object.freeze(events.sort((a,b)=>a.proposal.eventId.localeCompare(b.proposal.eventId))),progress:remote?.progress??Object.freeze({}),resume:remote?.resume??Object.freeze({mode:'none',sourceEvent:null,nextAction:null}),asOf:remote?.asOf??null,nextCursor:remote?.nextCursor??null,resumeCandidate:candidate,quarantined:Object.freeze(quarantined),remoteAccepted:remote!==null}); validatedMergeBrand.add(result); return result;
}

export function isValidatedStudentSnapshotMerge(value, { uid, releaseId }) { return record(value) && validatedMergeBrand.has(value) && value.uid === uid && value.releaseId === releaseId; }

export function createStudentSnapshotAdapter({ uid, releaseId, persistence, remote = null, trustedRelease, localUnansweredQuestion = () => null }) {
  if (!id(uid)||!id(releaseId)||!persistence?.readQueue||!trusted(trustedRelease)) throw new Error('A signed-in identity, release, trusted question validator, and persistence adapter are required.');
  const local=()=>persistence.readQueue();
  return Object.freeze({loadLocal:()=>Object.freeze({uid,releaseId,events:Object.freeze(local().map(item=>Object.freeze({proposal:item.proposal,source:'local',authoritative:false})))}),async loadAndMerge({cursor=undefined}={}){const snapshot=remote?.loadSnapshot?await remote.loadSnapshot({releaseId,...(cursor===undefined?{}:{cursor})}):null;return mergeAuthoritativeSnapshot({uid,releaseId,trustedRelease,localRecords:local(),remoteSnapshot:snapshot,localUnansweredQuestion:localUnansweredQuestion()});},async reconnect(){return this.loadAndMerge();}});
}
