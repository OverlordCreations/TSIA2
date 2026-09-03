import {
  createInitialState,
  evaluateResponse,
  getSkillStatus,
  getInitialView,
  isSavedStateCompatible,
  selectDomainStart,
  selectRecommendedNext
} from './engine.js';
import { buildDomainProgress, buildGrowthSummary, safeStudentSkillName, TSIA2_DOMAINS } from './progress.js';
import { studentFeedbackCopy, studentHintCopy, studentPromptCopy } from './student-display-copy.js';
import { createFirebaseClient } from './firebase-client.js';
import { createStudentClassController } from './class-membership.js';
import { renderStudentClassPanel } from './class-panel-view.js';
import { browserStorage, clearStudentNoticeForIdentity, createAttemptProposal, createInteractionLease, createPersistence, createSafeStorage, localAttemptRecord, mergeStudentSafeStatusCopy, prepareLegacyMigration, retryDelayMs, studentSafePersistenceNoticeCopy, studentSafeSyncStatusCopy, validAcknowledgementFor } from './persistence.js';
import { validHintAcknowledgement, validSessionAcknowledgement } from './attempt-contract.js';
import { renderRepresentation } from './representations.js';
import { nextHint, revealedHint } from './hints.js';
import { isEvaluationRelease } from './release-access.js';

function setStartupControls(disabled) {
  document.querySelector('#signInButton').disabled = disabled;
  document.querySelector('#restartButton').disabled = disabled;
}
function showStaticDataFailure(message = 'Practice data could not be loaded. Check your connection and try again.') {
  setStartupControls(true);
  const target = document.querySelector('#startupStatus');
  target.hidden = false;
  target.textContent = message;
  const retry = document.querySelector('#retryLoadButton');
  retry.hidden = false;
  retry.disabled = false;
  retry.onclick = () => window.location.reload();
  retry.focus();
}
function showReleaseGate() {
  setStartupControls(true);
  document.querySelector('#pageTitle').textContent = 'TSIA2 Math Practice';
  document.querySelector('#practiceContext').hidden = true;
  document.querySelector('#classPanel').hidden = true;
  document.querySelector('#questionCard').hidden = true;
  document.querySelector('#migrationPanel').hidden = true;
  document.querySelector('#whyPanel').hidden = true;
  document.querySelector('#entryPanel').hidden = false;
  document.querySelector('#entryHeading').textContent = 'Practice is not available yet';
  document.querySelector('#resumeMessage').hidden = true;
  document.querySelector('#resumeActions').hidden = true;
  document.querySelector('#recommendedNext').replaceChildren();
  document.querySelector('#domainChoices').replaceChildren();
  setSkipLinkTarget('progress');
  const target = document.querySelector('#startupStatus');
  target.hidden = false;
  target.textContent = 'Practice is being prepared. Please use the class link your teacher gives you.';
  document.querySelector('#retryLoadButton').hidden = true;
  target.focus();
}

async function init() {
// Offline cached bootstrap/service-worker support is intentionally not part of
// this bounded release. A first load still needs the static student export;
// only already-loaded local practice has the documented memory fallback.
let skillsData, questionData, releaseData;
try {
  [skillsData, questionData, releaseData] = await Promise.all([
  fetch('data/skills.json').then(response => {
    if (!response.ok) throw new Error('Skill data could not be loaded.');
    return response.json();
  }),
  fetch('data/questions.json').then(response => {
    if (!response.ok) throw new Error('Question data could not be loaded.');
    return response.json();
  }),
  fetch('data/release.json').then(response => {
    if (!response.ok) throw new Error('Release data could not be loaded.');
    return response.json();
  })
]);
} catch {
  showStaticDataFailure();
  return;
}

if (!Array.isArray(skillsData?.skills) || typeof skillsData.version !== 'string' || !Array.isArray(questionData?.questions) || typeof questionData.version !== 'string') {
  showStaticDataFailure();
  return;
}
const skills = skillsData.skills;
const skillsById = new Map(skills.map(skill => [skill.id, skill]));
const questionsById = new Map(questionData.questions.map(question => [question.id, question]));
if (!releaseData?.releaseId || releaseData.questionVersion !== questionData.version || releaseData.graphVersion !== skillsData.version) {
  showStaticDataFailure();
  return;
}
// A validation-only export is never a student-serving release. The only
// exception is the exact, build-stamped owner evaluation record; there is no
// query parameter, storage value, global, or remotely toggled bypass.
const evaluationRelease = isEvaluationRelease(releaseData);
if (!evaluationRelease && releaseData.persistentPilotEligible !== true) {
  showReleaseGate();
  return;
}
if (evaluationRelease) {
  const notice = document.querySelector('#evaluationNotice');
  notice.hidden = false;
  notice.textContent = 'Evaluation build for teacher testing. Practice saves on this device only. Content review is still in progress.';
}
document.querySelector('#startupStatus').hidden = true;
document.querySelector('#retryLoadButton').hidden = true;
document.querySelector('#restartButton').disabled = false;
const releaseId = releaseData.releaseId;
const localSessionId = globalThis.crypto?.randomUUID?.() ?? `local-session-${Date.now()}`;
const authoritativeSessions = new Map();
const sessionPromises = new Map();
const sharedStorage = createSafeStorage(browserStorage());
let persistence = createPersistence({ safeStorage: sharedStorage, questionVersion: questionData.version, releaseId });
let firebaseClient = null;
let classController = null;
let signedInUser = null;
let authGeneration = 0;
let syncInFlight = false;
let pendingResync = false;
let syncRetryTimer = null;
let activeInteraction = null;
const interactionLease = createInteractionLease();
let questionGeneration = 0;
let persistenceNoticeCopy = '';
let lastSyncStatusCopy = 'After this page loads, local practice is available on this device.';
const domains = TSIA2_DOMAINS;

function loadState() {
  // Read once at startup/identity changes so malformed saved attempts are
  // quarantined and explained even while the student is practicing offline.
  persistence.readQueue();
  const saved = persistence.readState();
  if (isSavedStateCompatible(saved, questionsById, skillsById)) return saved;
  if (saved !== null) persistence.reportNotice?.('saved-state-rejected');
  // v1.0 appends opaque IDs rather than renumbering old content. A v0.9
  // browser record can therefore be preserved only after both persistence
  // sanitization and current-engine validation succeed.
  const prior = persistence.readPriorVersionState?.('0.9.0');
  if (isSavedStateCompatible(prior, questionsById, skillsById)) {
    persistence.writeState(prior);
    return prior;
  }
  if (prior !== null) persistence.reportNotice?.('saved-state-rejected');
  return createInitialState(null);
}

let state = loadState();
let pendingEvidence = null;

const els = {
  pageTitle: document.querySelector('#pageTitle'),
  skillName: document.querySelector('#skillName'), skillStatus: document.querySelector('#skillStatus'),
  progress: document.querySelector('#progressBar'), progressMessage: document.querySelector('#progressMessage'),
  practiceContext: document.querySelector('#practiceContext'),
  entryPanel: document.querySelector('#entryPanel'), entryHeading: document.querySelector('#entryHeading'), homeAnnouncement: document.querySelector('#homeAnnouncement'),
  resumeMessage: document.querySelector('#resumeMessage'), resumeActions: document.querySelector('#resumeActions'),
  recommendedNext: document.querySelector('#recommendedNext'), domainChoices: document.querySelector('#domainChoices'), questionCard: document.querySelector('#questionCard'),
  prompt: document.querySelector('#questionPrompt'), questionAnnouncement: document.querySelector('#questionAnnouncement'), representation: document.querySelector('#questionRepresentation'), choices: document.querySelector('#answerChoices'), calculatorGuidance: document.querySelector('#calculatorGuidance'), submissionStatus: document.querySelector('#submissionStatus'),
  feedback: document.querySelector('#feedback'), next: document.querySelector('#nextButton'), progressButton: document.querySelector('#progressButton'),
  level: document.querySelector('#levelLabel'), attempt: document.querySelector('#attemptLabel'),
  hint: document.querySelector('#hint'), hintButton: document.querySelector('#hintButton'),
  restart: document.querySelector('#restartButton'), accountStatus: document.querySelector('#accountStatus'), syncStatus: document.querySelector('#syncStatus'),
  signIn: document.querySelector('#signInButton'), signOut: document.querySelector('#signOutButton'),
  classPanel: document.querySelector('#classPanel'), classStatus: document.querySelector('#classStatus'), classJoinForm: document.querySelector('#classJoinForm'), classJoinCode: document.querySelector('#classJoinCode'), classJoinButton: document.querySelector('#classJoinButton'), classRetry: document.querySelector('#classRetryButton'), classMemberships: document.querySelector('#classMemberships'),
  migrationPanel: document.querySelector('#migrationPanel'), confirmMigration: document.querySelector('#confirmMigrationButton'),
  dismissMigration: document.querySelector('#dismissMigrationButton')
};
renderPersistenceNotices();

const levelLabels = {
  foundational: 'Foundation check', core: 'Core skill', 'TSIA2-core': 'TSIA2 practice',
  advanced: 'Advanced challenge', 'SAT-ACT-extension': 'SAT / ACT extension'
};
const actionCopy = {
  ADVANCE: ['Nice work', 'You are ready for the next problem.'],
  RETRY: ['Keep going', 'Try another problem with the same idea.'],
  DIAGNOSE: ['Let’s look at one small idea', 'The next problem will help you practice it.'],
  REGRESS: ['Let’s build this step first', 'The next problem starts with an idea that will help.'],
  REMEDIATE: ['Try the idea again', 'A new problem will give you another chance to use it.'],
  TRANSFER: ['Ready for a challenge', 'The next problem uses this idea in a new situation.'],
  REVIEW: ['Let’s try one more', 'A new problem will give you another chance to show what you know.'],
  TEACHER_INTERVENTION: ['Time to check in', 'Ask your teacher what would help most before you continue.']
};

function saveState() { persistence.writeState(state); renderPersistenceNotices(); }
function setSyncStatus(message, { clearPersistenceNotice = false } = {}) {
  lastSyncStatusCopy = message;
  els.syncStatus.textContent = mergeStudentSafeStatusCopy(persistenceNoticeCopy, message);
  if (clearPersistenceNotice) persistenceNoticeCopy = '';
}
function renderPersistenceNotices() {
  const notices = persistence.consumeNotices?.() ?? [];
  const safeMessage = studentSafePersistenceNoticeCopy(notices);
  if (safeMessage) persistenceNoticeCopy = persistenceNoticeCopy ? `${persistenceNoticeCopy} ${safeMessage}` : safeMessage;
  if (safeMessage) setSyncStatus(lastSyncStatusCopy);
}
function renderAccountStatus(message, { signedIn = false, busy = false } = {}) {
  els.accountStatus.textContent = message;
  els.signIn.hidden = signedIn; els.signOut.hidden = !signedIn;
  els.signIn.disabled = busy; els.signOut.disabled = busy;
}
function refreshStateForUser(user) {
  persistenceNoticeCopy = clearStudentNoticeForIdentity(persistence.uid ?? null, user?.uid ?? null, persistenceNoticeCopy);
  persistence = createPersistence({ safeStorage: sharedStorage, questionVersion: questionData.version, releaseId, uid: user?.uid ?? null });
  state = loadState();
  renderPersistenceNotices();
}
function resetSyncStatusForIdentity(user, { pending = false } = {}) {
  setSyncStatus(studentSafeSyncStatusCopy({ signedIn:Boolean(user), pending }));
}
function resetCurrentView() {
  switch (getInitialView(state)) { case 'safe-exit': renderSafeExit(); break; case 'complete': renderComplete(); break; default: renderDomainSelection(); }
}
function identityIsCurrent(snapshot) { return authGeneration === snapshot.generation && signedInUser?.uid === snapshot.uid && persistence === snapshot.persistence; }
function validSessionReceipt(value, proposal) {
  return validSessionAcknowledgement(value, { sessionId: proposal.sessionId, questionId: proposal.questionId });
}
function sessionKey(question) { return `${signedInUser?.uid ?? 'unsigned'}|${releaseId}|${question.id}`; }
function sessionBinding(question) { return Object.freeze({ generation: authGeneration, uid: signedInUser?.uid ?? null, releaseId, questionId: question.id, questionGeneration }); }
function bindingIsCurrent(binding) { return binding.generation === authGeneration && binding.uid === (signedInUser?.uid ?? null) && binding.releaseId === releaseId && binding.questionId === currentQuestion()?.id && binding.questionGeneration === questionGeneration; }
function setInteraction(kind) { const lease = interactionLease.begin(kind); if (!lease) return null; activeInteraction = lease; [...els.choices.querySelectorAll('button')].forEach(button => { button.disabled = true; }); els.hintButton.disabled = true; els.restart.disabled = true; els.next.disabled = true; els.progressButton.disabled = true; return lease; }
function releaseInteraction(lease, { choicesEnabled = false, hintDisabled = true } = {}) { if (!interactionLease.release(lease)) return; activeInteraction = null; [...els.choices.querySelectorAll('button')].forEach(button => { button.disabled = !choicesEnabled; }); els.hintButton.disabled = hintDisabled; els.restart.disabled = false; els.next.disabled = false; els.progressButton.disabled = false; }
function clearInteractionForIdentityChange() { const lease = interactionLease.clear(); activeInteraction = null; if (!lease) return; [...els.choices.querySelectorAll('button')].forEach(button => { button.disabled = false; }); els.hintButton.disabled = false; els.restart.disabled = false; els.next.disabled = false; els.progressButton.disabled = false; }
function newSessionId() { return `session-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }
async function ensureAuthoritativeQuestionSession(question) {
  if (!firebaseClient || !signedInUser || firebaseClient.mode !== 'ready') return { sessionId: localSessionId, authoritative: false };
  const key = sessionKey(question); const existing = authoritativeSessions.get(key);
  if (existing?.authoritative) return existing;
  if (existing?.invalid) return { sessionId: `local-${localSessionId}`, authoritative: false };
  if (sessionPromises.has(key)) return sessionPromises.get(key);
  const binding = sessionBinding(question);
  const proposal = { sessionId: newSessionId(), releaseId, questionId: question.id };
  const pending = (async () => { try {
    const acknowledgement = await firebaseClient.startQuestionSession(proposal);
    if (!validSessionReceipt(acknowledgement, proposal)) throw new Error('The protected question session acknowledgement was invalid.');
    if (!bindingIsCurrent(binding)) return { sessionId: `local-${localSessionId}`, authoritative: false, stale: true };
    const session = { sessionId: proposal.sessionId, authoritative: true, invalid: false };
    authoritativeSessions.set(key, session); return session;
  } catch {
    if (bindingIsCurrent(binding)) authoritativeSessions.set(key, { sessionId: `local-${localSessionId}`, authoritative: false, invalid: true });
    return { sessionId: `local-${localSessionId}`, authoritative: false };
  } finally { if (sessionPromises.get(key) === pending) sessionPromises.delete(key); } })();
  sessionPromises.set(key, pending); return pending;
}
async function recordAuthoritativeHint(question, hintLevel) {
  const binding = sessionBinding(question);
  const key = sessionKey(question); const session = authoritativeSessions.get(key);
  if (!session?.authoritative || !firebaseClient || firebaseClient.mode !== 'ready') return false;
  try {
    const receipt = { hintEventId: `hint-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`, sessionId: session.sessionId, releaseId, questionId: question.id, hintLevel };
    const acknowledgement = await firebaseClient.recordHintUse(receipt);
    if (!validHintAcknowledgement(acknowledgement, { hintEventId: receipt.hintEventId })) throw new Error('The protected hint acknowledgement was invalid.');
    return bindingIsCurrent(binding);
  } catch {
    // A displayed local hint with no server receipt must never later look independent.
    if (bindingIsCurrent(binding)) authoritativeSessions.set(key, { ...session, authoritative: false, invalid: true });
    return false;
  }
}
function scheduleSyncRetry(snapshot, attempts) {
  if (syncRetryTimer || !identityIsCurrent(snapshot)) return;
  syncRetryTimer = setTimeout(() => { syncRetryTimer = null; syncPendingAttempts(snapshot); }, retryDelayMs(attempts));
}
function renderQueueSyncStatus(snapshot, { transient = false, sessionInvalid = false, clearPersistenceNotice = false } = {}) {
  if (!identityIsCurrent(snapshot)) return;
  const queue = snapshot.persistence.readQueue();
  const blocked = queue.filter(record => record.blocked === true).length;
  const retrying = queue.filter(record => record.blocked !== true).length;
  setSyncStatus(studentSafeSyncStatusCopy({ signedIn:true, blocked, retrying, transient, sessionInvalid }), { clearPersistenceNotice });
}
async function syncPendingAttempts(snapshot = { generation: authGeneration, uid: signedInUser?.uid, persistence }) {
  if (syncInFlight) { pendingResync = true; return; }
  if (!firebaseClient || !signedInUser || firebaseClient.mode !== 'ready' || !identityIsCurrent(snapshot)) return;
  syncInFlight = true;
  for (const record of snapshot.persistence.readQueue()) {
    if (!identityIsCurrent(snapshot)) break;
    if (record.blocked === true) continue;
    if (record.nextRetryAt && Date.parse(record.nextRetryAt) > Date.now()) { scheduleSyncRetry(snapshot, record.attempts); continue; }
    try {
      snapshot.persistence.markAttempt(record.proposal.eventId);
      const acknowledgement = await firebaseClient.submitAttemptProposal(record.proposal);
      if (!identityIsCurrent(snapshot)) break;
      if (!validAcknowledgementFor(record, acknowledgement)) throw Object.assign(new Error('Acknowledgement does not match the submitted attempt.'), { code: 'ack-mismatch' });
      snapshot.persistence.acknowledge(record, acknowledgement);
    } catch (error) {
      const code = String(error?.code ?? '').replace(/^functions\//, '');
      if (code === 'already-exists') {
        snapshot.persistence.quarantineConflict(record, code);
        continue;
      }
      if (['invalid-argument', 'failed-precondition'].includes(code)) {
        snapshot.persistence.recordIssue(record, code);
        continue;
      }
      if (['unauthenticated', 'permission-denied'].includes(code)) {
        snapshot.persistence.blockPendingAttempts();
        if (identityIsCurrent(snapshot)) {
          renderAccountStatus('Your sign-in needs to be refreshed before saved attempts can sync. Sign out, then sign in again. Local practice is still available.', { signedIn: true });
          renderPersistenceNotices();
          renderQueueSyncStatus(snapshot, { sessionInvalid:true, clearPersistenceNotice:true });
        }
        syncInFlight = false;
        pendingResync = false;
        return;
      }
      if (identityIsCurrent(snapshot)) {
        snapshot.persistence.markTransient(record.proposal.eventId);
        renderAccountStatus(`Signed in as ${signedInUser.displayName ?? 'this student'}. Progress is waiting to sync.`, { signedIn: true });
        renderQueueSyncStatus(snapshot, { transient: true });
        renderPersistenceNotices();
        scheduleSyncRetry(snapshot, record.attempts + 1);
      }
      syncInFlight = false;
      if (pendingResync) { pendingResync = false; syncPendingAttempts(); }
      return;
    }
  }
  syncInFlight = false;
  if (pendingResync) { pendingResync = false; syncPendingAttempts(); }
  if (identityIsCurrent(snapshot)) {
    const retainedBlocked = snapshot.persistence.readQueue().filter(record => record.blocked === true).length;
    renderAccountStatus(`Signed in as ${signedInUser.displayName ?? 'this student'}. ${retainedBlocked ? 'Practice can continue on this device.' : 'Progress is saved for this session.'}`, { signedIn: true });
    renderPersistenceNotices();
    renderQueueSyncStatus(snapshot, { clearPersistenceNotice:true });
  }
}
function showLegacyMigration(user) {
  const unsignedPersistence = createPersistence({ safeStorage: sharedStorage, questionVersion: questionData.version, releaseId });
  // Both the current unsigned key and the retired phase key are legacy once a
  // user signs in. Neither is ever attached without an explicit choice.
  // A pre-release-scoped browser state is legacy only. It is considered at
  // this explicit consent boundary and is never silently attached or erased.
  const currentUnsigned = unsignedPersistence.readState() ?? unsignedPersistence.findUnscopedState?.();
  const legacyState = prepareLegacyMigration({ uid: user.uid, questionVersion: questionData.version, legacyState: currentUnsigned }) ? currentUnsigned : unsignedPersistence.findLegacyState();
  const pending = prepareLegacyMigration({ uid: user.uid, questionVersion: questionData.version, legacyState });
  if (!pending || persistence.getMigration()?.migrationId === pending.migrationId) return;
  els.migrationPanel.hidden = false;
  els.confirmMigration.onclick = () => {
    // This is a local consent receipt only. A future callable may import only
    // explicitly consented, provisional legacy evidence.
    const queueReceipt = persistence.transferQueueFrom(unsignedPersistence);
    persistence.setMigration({ migrationId: pending.migrationId, status: queueReceipt.conflicts ? 'consented-with-queue-conflicts' : 'consented-local-only', consentedAt: new Date().toISOString(), snapshotFingerprint: pending.snapshotFingerprint, queueReceipt });
    if ((state.attempts?.length ?? 0) === 0 && pending.legacyState && isSavedStateCompatible(pending.legacyState, questionsById, skillsById)) {
      state = pending.legacyState;
      saveState();
      renderDomainSelection();
    }
    els.migrationPanel.hidden = true;
    if (signedInUser?.uid === user.uid) syncPendingAttempts({ generation: authGeneration, uid: user.uid, persistence });
  };
  els.dismissMigration.onclick = () => { els.migrationPanel.hidden = true; };
}
async function initializeIdentity() {
  firebaseClient = evaluationRelease
    ? await createFirebaseClient({ enabled: false })
    : await createFirebaseClient();
  classController = createStudentClassController({ client: firebaseClient, render: (classState, dispatch) => renderStudentClassPanel(els, classState, dispatch) });
  classController.start();
  if (firebaseClient.mode === 'disabled') {
    renderAccountStatus(evaluationRelease
      ? 'Sign-in is disabled for this evaluation build. Practice saves on this device only.'
      : 'Practice is available without signing in. Sign-in will be enabled for the approved pilot.', { signedIn: false });
    els.signIn.disabled = true;
    return;
  }
  if (firebaseClient.mode === 'error') {
    renderAccountStatus(firebaseClient.message, { signedIn: false });
    els.signIn.disabled = true;
    return;
  }
  renderAccountStatus('Checking sign-in status…', { busy: true });
  firebaseClient.subscribeAuthState((user, error) => {
    authGeneration += 1;
    if (syncRetryTimer) { clearTimeout(syncRetryTimer); syncRetryTimer = null; }
    clearInteractionForIdentityChange();
    els.migrationPanel.hidden = true; els.confirmMigration.onclick = null; els.dismissMigration.onclick = null;
    if (error) { signedInUser = null; refreshStateForUser(null); resetSyncStatusForIdentity(null); resetCurrentView(); renderAccountStatus('We could not check sign-in. Your local practice is still available.', { signedIn: false }); return; }
    signedInUser = user; authoritativeSessions.clear(); sessionPromises.clear();
    refreshStateForUser(user); resetSyncStatusForIdentity(user, { pending: Boolean(user) }); resetCurrentView();
    if (!user) { renderAccountStatus('Practice is available without signing in.', { signedIn: false }); return; }
    renderAccountStatus(`Signed in as ${user.displayName ?? 'this student'}. Syncing saved progress…`, { signedIn: true });
    showLegacyMigration(user); syncPendingAttempts({ generation: authGeneration, uid: user.uid, persistence });
  });
  els.signIn.addEventListener('click', async () => {
    renderAccountStatus('Opening secure Google sign-in…', { busy: true });
    try { await firebaseClient.signInWithGoogle(); } catch (error) { renderAccountStatus(error.message, { signedIn: false }); }
  });
  els.signOut.addEventListener('click', async () => {
    try { await firebaseClient.signOut(); }
    catch { renderAccountStatus('We could not sign you out right now. Please close this browser session before another student uses it.', { signedIn: true }); }
  });
  window.addEventListener('online', () => syncPendingAttempts());
}
function currentQuestion() { return questionsById.get(state.currentQuestionId); }
function skillNameForId(skillId) { return safeStudentSkillName(skillsById.get(skillId)); }
function currentDomainName() {
  const code = currentQuestion()?.metadata?.domainCode;
  return domains.find(domain => domain.code === code)?.name ?? 'your current math area';
}
function lockChoices() { [...els.choices.querySelectorAll('button')].forEach(button => { button.disabled = true; }); }
function calculatorGuidanceCopy(question) {
  switch (question?.metadata?.calculatorPolicy) {
    case 'not-required': return 'A calculator is not required for this question.';
    case 'allowed': return 'You may use a calculator if your teacher allows one.';
    case 'required': return 'Use a calculator for this question if one is available to you.';
    default: return 'Use the tools your teacher permits.';
  }
}
function setSkipLinkTarget(view) {
  const link = document.querySelector('#skipLink');
  if (!link) return;
  const target = view === 'question'
    ? { href:'#questionPrompt', label:'Skip to the current question' }
    : view === 'summary'
      ? { href:'#recommendedNextHeading', label:'Skip to session summary' }
      : { href:'#entryHeading', label:'Skip to your practice choices' };
  link.href = target.href;
  link.textContent = target.label;
}
function setSubmissionState(choiceId = null, submitting = typeof choiceId === 'string') {
  els.questionCard.setAttribute('aria-busy', String(submitting));
  els.submissionStatus.hidden = !submitting;
  els.submissionStatus.textContent = submitting ? 'Checking your answer.' : '';
  for (const button of els.choices.querySelectorAll('button')) {
    const selected = button.dataset.choiceId === choiceId;
    button.classList.toggle('selected-choice', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}
function makeButton(label, className, onClick, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className; button.textContent = label; button.disabled = disabled;
  if (!disabled) button.addEventListener('click', onClick);
  return button;
}

function getRecommendation(domainCode = null) {
  return selectRecommendedNext({ state, skillsById, questionsById, questionData, domainCode,
    currentSkillId: currentQuestion()?.skillId ?? null });
}

// This is deliberately the same pure plan that `startDomain` applies.  Cards
// must never describe a different task than their buttons will start.
function getDomainPlan(domainCode) {
  return selectDomainStart({ state, domainCode, skillsById, questionsById, questionData });
}

function recommendationCopy(recommendation, { selectedDomain = false } = {}) {
  if (recommendation.safeExit) return 'Ask your teacher which problem would be most helpful next.';
  if (recommendation.reasonCategory === 'baseline-diagnostic') return 'Start with one short problem so we can choose a good place to begin.';
  if (recommendation.reasonCategory === 'blocking-prerequisite') return selectedDomain
    ? 'This choice starts with one smaller idea that supports the work you selected.'
    : 'A smaller idea is the most useful next step right now.';
  if (recommendation.reasonCategory === 'current-skill-evidence') return 'A fresh problem lets you keep building this skill.';
  if (recommendation.reasonCategory === 'ready-frontier') return 'This is a good next skill based on your practice so far.';
  return 'A fresh practice question is ready when you are.';
}

function recommendedNextText(recommendation, options = {}) {
  if (recommendation.safeExit || !recommendation.selectedSkillId) return 'Next step: check in with your teacher before another problem.';
  const name = skillNameForId(recommendation.selectedSkillId);
  return `Try next: ${name}. ${recommendationCopy(recommendation, options)}`;
}

function domainPlanText(plan, options = {}) {
  if (!plan.selectedQuestionId) return recommendedNextText(plan.recommendation ?? { safeExit: plan.safeExit }, options);
  const question = questionsById.get(plan.selectedQuestionId);
  const name = skillNameForId(question?.skillId);
  if (plan.fromPending) return `Pick up where you left off: ${name}. Your unanswered problem is ready.`;
  if (!plan.recommendation) return `Pick up where you left off: ${name}. Your unanswered problem is ready.`;
  return recommendedNextText(plan.recommendation, options);
}

function learnerSummary(domain) {
  if (!domain.available) return 'Not Assessed. More practice for this area is being prepared.';
  if (domain.learner.state === 'not-assessed') return 'Not Assessed. You have not tried this area yet.';
  if (domain.learner.state === 'all-released-skills-mastered') return 'Mastered skills are shown below. Keep practicing when your teacher assigns more.';
  return `${domain.learner.assessedSkills} skill${domain.learner.assessedSkills === 1 ? '' : 's'} practiced: ${domain.learner.masteredSkills} Mastered and ${domain.learner.inProgressSkills} still growing.`;
}

function statusExplanation(status) {
  return {
    Mastered: 'You have shown this skill in several different problems.',
    'Near Mastery': 'You are very close. Another problem on your own can help.',
    Developing: 'You are building this skill through practice.',
    Emerging: 'You have started this skill. A smaller step may help.',
    'Not Assessed': 'You have not tried this skill yet.'
  }[status] ?? 'Keep practicing this skill one problem at a time.';
}

function recentPracticeCopy(summary) {
  if (summary.trend === 'improving') return 'Recent practice is getting stronger.';
  if (summary.trend === 'steady') return 'Recent practice is steady.';
  if (summary.trend === 'needs-focus') return 'Recent practice shows this area could use extra attention.';
  return 'Keep practicing before this area has a recent-practice note.';
}

function renderSkillDetails(domain) {
  const details = document.createElement('details'); details.className = 'skill-details';
  const summary = document.createElement('summary'); summary.textContent = domain.available ? 'See my skills in this area' : 'See this area';
  const coverage = document.createElement('p'); coverage.className = 'coverage-copy';
  coverage.textContent = 'Open a skill below to see what you have practiced and what to work on next.';
  const statusList = document.createElement('ul'); statusList.className = 'status-counts'; statusList.setAttribute('aria-label', 'Skill progress counts');
  for (const [status, count] of Object.entries(domain.learner.statusCounts)) {
    const item = document.createElement('li'); item.className = `status-pill status-${status.toLowerCase().replaceAll(' ', '-')}`;
    item.textContent = `${status}: ${count}`; statusList.append(item);
  }
  details.append(summary, coverage, statusList);
  if (domain.skills.length) {
    const rows = document.createElement('ul'); rows.className = 'skill-list';
    for (const skill of domain.skills) {
      const row = document.createElement('li');
      const name = document.createElement('span'); name.textContent = skill.name;
      const status = document.createElement('span'); status.className = `skill-status status-${skill.status.toLowerCase().replaceAll(' ', '-')}`; status.textContent = `${skill.status} — ${statusExplanation(skill.status)}`;
      row.append(name, status); rows.append(row);
    }
    details.append(rows);
  }
  return details;
}

function renderRecommendedNext(plan, domainCode, { canResume = false, resumeDomainName = null } = {}) {
  els.recommendedNext.replaceChildren();
  const heading = document.createElement('h3'); heading.id = 'recommendedNextHeading'; heading.textContent = canResume ? 'Pick up where you left off' : 'What should I practice next?';
  const copy = document.createElement('p');
  copy.id = 'recommendedNextCopy';
  copy.textContent = canResume
    ? `Resume the unanswered ${resumeDomainName ?? currentDomainName()} question before choosing something new.`
    : domainPlanText(plan, { selectedDomain: false });
  const action = plan?.selectedQuestionId
    ? makeButton(canResume ? 'Resume practice' : 'Practice this next step', 'next-button', () => startDomain(domainCode, plan))
    : makeButton('See what to do next', 'quiet-button', () => openSafePlan(plan));
  action.setAttribute('aria-describedby', copy.id);
  action.setAttribute('aria-label', canResume
    ? `Resume saved ${resumeDomainName ?? currentDomainName()} practice`
    : plan?.selectedQuestionId
      ? `Practice recommended next step: ${skillNameForId(questionsById.get(plan.selectedQuestionId)?.skillId)}`
      : 'See what to do next with your teacher');
  els.recommendedNext.append(heading, copy, action);
}

function openSafePlan(plan) {
  if (plan?.safeExit) {
    state.safeExit = plan.safeExit;
    saveState();
  }
  renderSafeExit();
}

function renderDomainSelection({ safeExit = false } = {}) {
  pendingEvidence = null;
  els.questionCard.hidden = true; els.entryPanel.hidden = false; els.practiceContext.hidden = true; els.classPanel.hidden = false;
  setSkipLinkTarget('progress');
  els.pageTitle.textContent = 'Your TSIA2 Math Progress';
  els.entryHeading.textContent = safeExit ? 'Choose what to practice next' : 'Your four TSIA2 math areas';
  const current = currentQuestion();
  const progress = buildDomainProgress({ state, skills, questions: questionData.questions });
  const growthByDomain = new Map(buildGrowthSummary({ state, questions: questionData.questions }).domains.map(summary => [summary.code, summary]));
  const plans = new Map(progress.filter(domain => domain.available).map(domain => [domain.code, getDomainPlan(domain.code)]));
  const currentCode = current?.metadata?.domainCode ?? null;
  const pendingDomain = !current
    ? domains.map(domain => ({ domain, plan: plans.get(domain.code) })).find(candidate => candidate.plan?.fromPending)
    : null;
  const globalPlan = pendingDomain?.plan ?? (currentCode && plans.get(currentCode)
    ? plans.get(currentCode)
    : getRecommendation());
  const globalDomain = pendingDomain?.domain.code ?? currentCode ?? questionsById.get(globalPlan?.selectedQuestionId)?.metadata?.domainCode ?? 'QR';
  const canResume = !safeExit && Boolean(current || pendingDomain);
  els.resumeMessage.hidden = true; els.resumeActions.hidden = true; els.resumeActions.replaceChildren();
  renderRecommendedNext(globalPlan, globalDomain, { canResume, resumeDomainName: pendingDomain?.domain.name ?? null });
  els.domainChoices.replaceChildren();
  for (const domain of progress) {
    const plan = plans.get(domain.code) ?? null;
    const card = document.createElement('article');
    card.className = `domain-card${domain.available ? '' : ' unavailable'}`;
    const title = document.createElement('h3'); title.textContent = `${domain.code} — ${domain.name}`;
    const copy = document.createElement('p'); copy.textContent = domain.description;
    const status = document.createElement('p'); status.className = 'domain-status'; status.textContent = learnerSummary(domain);
    const practice = growthByDomain.get(domain.code);
    const coverage = document.createElement('p'); coverage.className = 'domain-coverage';
    coverage.textContent = `Progress so far: ${practice.questionsTried} question${practice.questionsTried === 1 ? '' : 's'} tried • ${practice.correctWithoutHints} correct without hints • help used on ${practice.questionsWithHelp} question${practice.questionsWithHelp === 1 ? '' : 's'}.`;
    const recent = document.createElement('p'); recent.className = 'domain-recommendation'; recent.textContent = recentPracticeCopy(practice);
    card.append(title, copy, status, coverage, recent, renderSkillDetails(domain));
    if (domain.available) {
      const hasCandidate = Boolean(plan?.selectedQuestionId);
      const next = document.createElement('p'); next.className = 'domain-recommendation';
      next.textContent = hasCandidate
        ? domainPlanText(plan, { selectedDomain: true })
        : 'There is not another problem ready in this area yet. Ask your teacher what to try next.';
      card.append(next, hasCandidate
        ? makeButton(plan.fromPending ? `Resume ${domain.name}` : `Practice ${domain.name}`, 'domain-button', () => startDomain(domain.code, plan))
        : makeButton('Practice paused — check in', 'domain-button', () => {}, true));
    } else {
      card.append(makeButton('More practice is being prepared', 'domain-button', () => {}, true));
    }
    els.domainChoices.append(card);
  }
  const homeRecommendation = canResume
    ? `Resume the unanswered ${pendingDomain?.domain.name ?? currentDomainName()} question.`
    : domainPlanText(globalPlan, { selectedDomain:false });
  els.homeAnnouncement.textContent = `${safeExit ? 'Your practice choices are ready.' : 'Your TSIA2 Math Progress is ready.'} ${homeRecommendation}`;
  els.recommendedNext.querySelector('button')?.focus();
}

function startDomain(domainCode, selection = getDomainPlan(domainCode)) {
  const current = currentQuestion();
  // A requested domain with no safe candidate must never discard an unanswered
  // question from another domain.
  if (!selection.selectedQuestionId) {
    if (!current && selection.safeExit) {
      state.safeExit = selection.safeExit; saveState(); renderSafeExit();
    }
    return;
  }
  if (current && current.id !== selection.selectedQuestionId) {
    const currentDomain = current.metadata?.domainCode;
    if (currentDomain) {
      state.pendingQuestionIds ??= {};
      state.pendingQuestionIds[currentDomain] = current.id;
    }
  }
  const pending = state.pendingQuestionIds;
  if (pending?.[domainCode] === selection.selectedQuestionId) delete pending[domainCode];
  const resumingCurrentQuestion = current?.id === selection.selectedQuestionId;
  state.currentQuestionId = selection.selectedQuestionId; if (!resumingCurrentQuestion) state.hintLevel = 0; state.safeExit = null;
  saveState(); renderQuestion();
}

function sessionStorageCopy() {
  return sharedStorage.usingMemoryFallback
    ? 'This browser cannot save locally right now. Practice will continue until this tab closes.'
    : 'Your practice is saved on this device in this browser.';
}

function renderSessionSummary(variant) {
  const checkIn = variant === 'teacher-check-in';
  const recommendation = checkIn ? null : getRecommendation();
  const nextQuestion = recommendation?.selectedQuestionId ? questionsById.get(recommendation.selectedQuestionId) : null;
  const nextDomain = nextQuestion?.metadata?.domainCode ?? 'QR';
  const responseCount = state.attempts.length;
  els.questionCard.hidden = true; els.entryPanel.hidden = false; els.classPanel.hidden = true;
  setSkipLinkTarget('summary');
  els.practiceContext.hidden = false;
  els.pageTitle.textContent = 'TSIA2 Math Practice';
  els.skillName.textContent = checkIn ? 'Practice paused' : 'Practice set';
  els.skillStatus.textContent = checkIn ? 'Ask your teacher' : 'Practice set complete';
  els.progress.style.width = '0%';
  els.progressMessage.textContent = checkIn
    ? 'Talk with your teacher about the best next problem.'
    : 'You have finished the problems currently ready here. More TSIA2 practice may still be ahead.';
  els.entryHeading.textContent = checkIn ? 'Let’s choose your next step together' : 'You finished this set of practice problems';
  els.resumeMessage.hidden = false;
  els.resumeMessage.textContent = `${responseCount} response${responseCount === 1 ? '' : 's'} in this practice session. ${sessionStorageCopy()}`;
  els.recommendedNext.replaceChildren();
  const summaryHeading = document.createElement('h3'); summaryHeading.id = 'recommendedNextHeading'; summaryHeading.tabIndex = -1;
  const summaryCopy = document.createElement('p'); summaryCopy.id = 'recommendedNextCopy';
  if (nextQuestion) {
    summaryHeading.textContent = 'What should I practice next?';
    summaryCopy.textContent = recommendedNextText(recommendation);
    const action = makeButton('Practice this next step', 'next-button', () => startDomain(nextDomain, recommendation));
    action.setAttribute('aria-describedby', summaryCopy.id);
    action.setAttribute('aria-label', `Practice next: ${skillNameForId(nextQuestion.skillId)}`);
    els.recommendedNext.append(summaryHeading, summaryCopy, action);
  } else {
    summaryHeading.textContent = 'Check in with your teacher';
    summaryCopy.textContent = 'Ask your teacher what would be most helpful to try next.';
    els.recommendedNext.append(summaryHeading, summaryCopy);
  }
  els.resumeActions.hidden = false;
  els.resumeActions.replaceChildren(makeButton('View my progress', 'quiet-button', () => renderDomainSelection({ safeExit: checkIn })));
  els.domainChoices.replaceChildren();
  els.homeAnnouncement.textContent = nextQuestion
    ? `Practice ${skillNameForId(nextQuestion.skillId)} next.`
    : 'Check in with your teacher before the next problem.';
  (nextQuestion ? els.recommendedNext.querySelector('button') : summaryHeading).focus();
}

function renderSafeExit() { renderSessionSummary('teacher-check-in'); }

function renderComplete() { renderSessionSummary('available-path-complete'); }

function renderHint(text, prompt = '') {
  els.hint.replaceChildren();
  const title = document.createElement('strong'); title.textContent = 'Try this small step';
  const copy = document.createElement('p'); copy.textContent = studentHintCopy(text, prompt);
  els.hint.append(title, copy);
}

function renderQuestion() {
  questionGeneration += 1;
  const renderedQuestionGeneration = questionGeneration;
  pendingEvidence = null;
  if (state.safeExit) return renderSafeExit();
  const question = currentQuestion();
  if (!question) return renderComplete();
  const skill = skillsById.get(question.skillId);
  els.entryPanel.hidden = true; els.questionCard.hidden = false; els.classPanel.hidden = true;
  setSkipLinkTarget('question');
  els.practiceContext.hidden = false;
  els.pageTitle.textContent = 'TSIA2 Math Practice';
  els.skillName.textContent = safeStudentSkillName(skill); els.skillStatus.textContent = getSkillStatus(state, skill, questionsById);
  els.progress.style.width = '0%';
  els.progressMessage.textContent = question.role === 'recovery' ? 'Try this smaller step, then keep building from there.'
    : question.role === 'transfer' ? 'This problem uses the same idea in a new situation.' : 'Start where you are. We’ll take one problem at a time.';
  els.level.textContent = levelLabels[question.difficulty] ?? 'Math practice'; els.attempt.textContent = `Question ${state.attempts.length + 1}`;
  els.prompt.textContent = studentPromptCopy(question.prompt); renderRepresentation(els.representation, question.representation); els.choices.setAttribute('aria-describedby', question.representation ? 'questionChoiceHelp questionRepresentation' : 'questionChoiceHelp'); els.choices.replaceChildren(); els.feedback.hidden = true; els.feedback.className = 'feedback';
  els.calculatorGuidance.textContent = calculatorGuidanceCopy(question); els.calculatorGuidance.hidden = false; setSubmissionState();
  els.next.hidden = true; els.progressButton.hidden = true; els.hint.hidden = true; els.hintButton.hidden = false; els.hintButton.disabled = false; els.hintButton.textContent = 'Show me a small step';
  // A persisted hint is assistance already used, not a new interaction.  It
  // must appear again after reload without incrementing state or contacting
  // the optional authoritative hint path.
  const savedHint = revealedHint(question, state.hintLevel ?? 0);
  if (savedHint) {
    renderHint(savedHint.text, question.prompt);
    els.hint.hidden = false;
    els.hintButton.textContent = savedHint.hasMore ? 'Show me the next step' : 'All small steps shown';
    els.hintButton.disabled = !savedHint.hasMore;
  }
  for (const choice of question.choices) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'choice'; button.textContent = choice.text; button.dataset.choiceId = choice.id; button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => answer(question, choice.id)); els.choices.appendChild(button);
  }
  els.questionAnnouncement.textContent = '';
  const announceAndFocus = () => {
    if (questionGeneration !== renderedQuestionGeneration || currentQuestion()?.id !== question.id) return;
    els.questionAnnouncement.textContent = `New problem. ${safeStudentSkillName(skill)}. Question ${state.attempts.length + 1}.`;
    els.prompt.focus({ preventScroll:true });
  };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(announceAndFocus);
  else setTimeout(announceAndFocus, 0);
}

async function answer(question, choiceId) {
  // The event is fixed before the local engine sees correctness or routing.
  // The queue transmits only the five callable fields; local conclusions are
  // labeled non-authoritative and remain for offline continuity only.
  if (activeInteraction) return;
  const binding = sessionBinding(question); const before = structuredClone(state); let committed = false; let focusTarget = null;
  const interaction = setInteraction('answer'); if (!interaction) return; setSubmissionState(choiceId); lockChoices();
  try {
    const authoritativeSession = await ensureAuthoritativeQuestionSession(question);
    if (!bindingIsCurrent(binding)) return;
    const proposal = createAttemptProposal({ sessionId: authoritativeSession.sessionId, releaseId, question, choiceId });
    const localContext = { questionVersion: questionData.version, graphVersion: skillsData.version, domainCode: question.metadata?.domainCode ?? null,
      skillId: question.skillId, questionRole: question.role, difficulty: question.difficulty, occurredAtClient: new Date().toISOString() };
    const masteryBefore = structuredClone(state.mastery?.[question.skillId] ?? null);
    pendingEvidence = evaluateResponse({ question, choiceId, state, skillsById, questionsById, hintLevel: state.hintLevel ?? 0 });
    els.skillStatus.textContent = getSkillStatus(state, skillsById.get(question.skillId), questionsById);
    const record = localAttemptRecord(proposal, pendingEvidence, masteryBefore, state.mastery?.[question.skillId] ?? null, localContext);
    persistence.commitAttemptAndState(record, state);
    committed = true; renderPersistenceNotices(); els.hintButton.disabled = true;
    void syncPendingAttempts();
    const [heading, summary] = pendingEvidence.correctness
      ? actionCopy[pendingEvidence.recommendedNextAction] ?? ['Nice work', 'You are ready for the next problem.']
      : ['Let’s look at that choice', 'Read the feedback, then try the next problem when you are ready.'];
    els.feedback.hidden = false; els.feedback.className = `feedback ${pendingEvidence.correctness ? 'good' : 'coach'}`; els.feedback.replaceChildren();
    const label = document.createElement('strong'); label.textContent = heading;
    const explanation = document.createElement('p'); explanation.textContent = studentFeedbackCopy(pendingEvidence.explanation, question.prompt);
    const nextStep = document.createElement('p'); nextStep.textContent = summary;
    els.feedback.append(label, explanation, nextStep);
    els.next.textContent = pendingEvidence.safeExit ? 'Choose a domain' : pendingEvidence.recommendedNextQuestion ? 'Continue' : 'Finish';
    els.next.hidden = false; els.next.onclick = pendingEvidence.safeExit ? renderSafeExit : renderQuestion; focusTarget = els.feedback;
    els.progressButton.hidden = false; els.progressButton.onclick = renderDomainSelection;
  } catch {
    if (!committed) {
      const recovered = persistence.recoverPendingAttempt?.();
      if (isSavedStateCompatible(recovered, questionsById, skillsById)) {
        state = recovered; committed = true; renderPersistenceNotices();
      } else {
        state = before;
        if (!persistence.hasPendingAttempt?.()) {
          try { saveState(); } catch { /* A later safe-storage recovery keeps the previous state. */ }
        }
      }
    }
    if (bindingIsCurrent(binding)) {
      els.feedback.hidden = false; els.feedback.className = 'feedback coach'; els.feedback.textContent = 'We could not finish that step. Your practice is still available; please try again.';
      els.next.hidden = false; els.next.textContent = committed ? 'Continue' : persistence.hasPendingAttempt?.() ? 'Reload to recover this saved answer' : 'Try this question again'; els.next.onclick = committed ? renderQuestion : persistence.hasPendingAttempt?.() ? () => window.location.reload() : renderQuestion;
      els.progressButton.hidden = false; els.progressButton.onclick = renderDomainSelection;
      focusTarget = els.feedback;
    }
  } finally {
    setSubmissionState(committed ? choiceId : null, false);
    releaseInteraction(interaction, { choicesEnabled:false, hintDisabled:true });
    focusTarget?.focus();
  }
}

els.hintButton.addEventListener('click', async () => {
  if (activeInteraction) return;
  const question = currentQuestion();
  const binding = sessionBinding(question); const interaction = setInteraction('hint'); if (!interaction) return;
  let hint = null;
  const hintLevelBefore = state.hintLevel ?? 0;
  const hintViewBefore = { hidden:els.hint.hidden, text:els.hint.textContent, buttonText:els.hintButton.textContent };
  try {
    hint = nextHint(question, state.hintLevel ?? 0);
    await ensureAuthoritativeQuestionSession(question);
    await recordAuthoritativeHint(question, hint.level);
    if (!bindingIsCurrent(binding)) return;
    state.hintLevel = hint.level;
    renderHint(hint.text, question.prompt);
    els.hint.hidden = false;
    els.hintButton.textContent = hint.hasMore ? 'Show me the next step' : 'All small steps shown';
    saveState();
    els.questionAnnouncement.textContent = `Small step ${hint.level} is ready.`;
    els.hint.focus();
  } catch {
    if (bindingIsCurrent(binding)) {
      state.hintLevel = hintLevelBefore;
      els.hint.hidden = hintViewBefore.hidden;
      els.hint.textContent = hintViewBefore.text;
      els.hintButton.textContent = hintViewBefore.buttonText;
      els.feedback.hidden = false;
      els.feedback.className = 'feedback coach';
      els.feedback.textContent = 'A hint could not be prepared. You can keep working or try the hint again.';
      els.questionAnnouncement.textContent = 'A hint could not be prepared. You can keep working or try again.';
      els.feedback.focus();
    }
  } finally {
    releaseInteraction(interaction, { choicesEnabled:true, hintDisabled:hint ? !hint.hasMore : false });
  }
});
els.restart.addEventListener('click', renderDomainSelection);
initializeIdentity();
switch (getInitialView(state)) {
  case 'safe-exit':
    renderSafeExit();
    break;
  case 'complete':
    renderComplete();
    break;
  default:
    renderDomainSelection();
}
}

void init();
