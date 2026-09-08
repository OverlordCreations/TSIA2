import { firebaseAuthIsConfigured, firebaseConfig, firebaseSdkVersion, firebaseSyncIsConfigured } from './firebase-config.js';

const sdk = name => `https://www.gstatic.com/firebasejs/${firebaseSdkVersion}/firebase-${name}.js`;
const friendlyError = error => {
  const code = error?.code ?? '';
  if (code.includes('popup-closed')) return 'Sign-in was cancelled. Practice is still available without signing in.';
  if (code.includes('popup-blocked')) return 'Your browser blocked the sign-in window. Allow pop-ups and try again.';
  if (code.includes('network')) return 'We could not reach the sign-in service. Your local practice is still available.';
  return 'We could not sign you in right now. Your local practice is still available.';
};

export function createAuthStateMachine({ client, onChange = () => {} }) {
  let state = client?.mode === 'disabled' ? 'disabled' : client?.mode === 'error' ? 'failure' : 'pending';
  const emit = (next, detail = null) => { state = next; onChange(Object.freeze({ state, detail })); };
  return Object.freeze({
    get state() { return state; },
    subscribe() { if (!client?.subscribeAuthState) { emit('failure'); return () => {}; } return client.subscribeAuthState((user, error) => emit(error ? 'failure' : user ? 'signed-in' : 'signed-out', error ?? user ?? null)); },
    async signIn() { emit('pending'); try { const result = await client.signInWithGoogle(); if (result?.user) emit('signed-in', result.user); return result; } catch (error) { emit('failure', error); throw error; } },
    async signOut() { emit('pending'); try { await client.signOut(); emit('signed-out'); } catch (error) { emit('failure', error); throw error; } }
  });
}

export async function createFirebaseClient(config = firebaseConfig, { loadSdk = name => import(sdk(name)) } = {}) {
  if (!firebaseAuthIsConfigured(config)) return disabledClient();
  try {
    // Authentication is deliberately independent from protected sync. The
    // Spark evaluation site must never initialize Functions or App Check.
    const [{ initializeApp }, authSdk] = await Promise.all([loadSdk('app'), loadSdk('auth')]);
    const app = initializeApp(config);
    const auth = authSdk.getAuth(app);
    await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    const provider = new authSdk.GoogleAuthProvider();
    // Do not add scopes: Firebase's identity scope is the only requested data.
    const authClient = {
      mode: 'auth-only',
      authEnabled: true,
      syncEnabled: false,
      subscribeAuthState: callback => authSdk.onAuthStateChanged(auth, callback, error => callback(null, error)),
      signInWithGoogle: async () => {
        try { return await authSdk.signInWithPopup(auth, provider); }
        catch (error) {
          // Popups are best on ordinary Chromebooks. Redirect is reserved for a
          // popup-blocked or narrow/mobile context and returns through the auth observer.
          const narrow = globalThis.matchMedia?.('(max-width: 620px)')?.matches;
          if (error?.code?.includes('popup-blocked') || narrow) { await authSdk.signInWithRedirect(auth, provider); return null; }
          throw new Error(friendlyError(error));
        }
      },
      signOut: () => authSdk.signOut(auth),
      submitAttemptProposal: syncUnavailable,
      startQuestionSession: syncUnavailable,
      recordHintUse: syncUnavailable,
      loadStudentSnapshot: syncUnavailable,
      listStudentMemberships: syncUnavailable,
      joinClass: syncUnavailable,
      leaveClass: syncUnavailable,
      errorMessage: friendlyError
    };
    if (!firebaseSyncIsConfigured(config)) return authClient;

    // This branch is intentionally unreachable for the free Spark evaluation
    // configuration. It remains a separate fail-closed seam for a future,
    // explicitly approved protected-sync release.
    const [functionsSdk, appCheckSdk] = await Promise.all([loadSdk('functions'), loadSdk('app-check')]);
    appCheckSdk.initializeAppCheck(app, { provider: new appCheckSdk.ReCaptchaEnterpriseProvider(config.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
    const functions = functionsSdk.getFunctions(app, config.functionsRegion);
    return {
      ...authClient,
      mode: 'ready',
      syncEnabled: true,
      submitAttemptProposal: proposal => functionsSdk.httpsCallable(functions, 'submitAttempt')(onlyCallableFields(proposal)).then(result => result.data),
      startQuestionSession: proposal => functionsSdk.httpsCallable(functions, 'startQuestionSession')(onlySessionFields(proposal)).then(result => result.data),
      recordHintUse: receipt => functionsSdk.httpsCallable(functions, 'recordHintUse')(onlyHintFields(receipt)).then(result => result.data),
      loadStudentSnapshot: proposal => functionsSdk.httpsCallable(functions, 'getStudentSnapshot')(onlySnapshotFields(proposal)).then(result => result.data),
      listStudentMemberships: () => functionsSdk.httpsCallable(functions, 'listStudentMemberships')({}).then(result => result.data),
      joinClass: proposal => functionsSdk.httpsCallable(functions, 'joinClass')(onlyJoinFields(proposal)).then(result => result.data),
      leaveClass: proposal => functionsSdk.httpsCallable(functions, 'leaveClass')(onlyLeaveFields(proposal)).then(result => result.data),
    };
  } catch (error) {
    return { ...disabledClient(), mode: 'error', message: friendlyError(error) };
  }
}

function onlyCallableFields(proposal) {
  const { eventId, sessionId, releaseId, questionId, choiceId } = proposal;
  return { eventId, sessionId, releaseId, questionId, choiceId };
}

function onlySessionFields(proposal) {
  const { sessionId, releaseId, questionId } = proposal;
  return { sessionId, releaseId, questionId };
}

function onlyHintFields(receipt) {
  const { hintEventId, sessionId, releaseId, questionId, hintLevel } = receipt;
  return { hintEventId, sessionId, releaseId, questionId, hintLevel };
}

function onlyJoinFields(proposal) {
  const { requestId, joinCode } = proposal ?? {};
  return { requestId, joinCode };
}

function onlyLeaveFields(proposal) {
  const { requestId, classId } = proposal ?? {};
  return { requestId, classId };
}

function onlySnapshotFields(proposal) {
  const { releaseId, pageSize, cursor } = proposal ?? {};
  const result = { releaseId };
  if (pageSize !== undefined) result.pageSize = pageSize;
  if (cursor !== undefined) result.cursor = cursor;
  return result;
}

async function syncUnavailable() {
  throw new Error('Cloud progress sync is not enabled. Practice progress remains on this Chromebook.');
}

function disabledClient() {
  const unavailable = async () => { throw new Error('Class features are not enabled for this practice site yet.'); };
  return { mode: 'disabled', subscribeAuthState: callback => { callback(null, null); return () => {}; }, signInWithGoogle: async () => { throw new Error('Sign-in is not enabled for this practice site yet.'); }, signOut: async () => {}, submitAttemptProposal: async () => { throw new Error('Cloud sync is not enabled.'); }, startQuestionSession: async () => { throw new Error('Cloud sync is not enabled.'); }, recordHintUse: async () => { throw new Error('Cloud sync is not enabled.'); }, loadStudentSnapshot: unavailable, listStudentMemberships: unavailable, joinClass: unavailable, leaveClass: unavailable, errorMessage: () => 'Class features are not enabled for this practice site yet.' };
}
