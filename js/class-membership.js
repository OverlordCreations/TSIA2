// Browser-side distrust boundary for the three student class callables. Class
// IDs stay inside the controller and event closures; they are never copied to
// rendered text, attributes, status, or stored browser state.
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const classId = value => typeof value === 'string' && /^class-[A-Za-z0-9._:-]{1,154}$/.test(value) && !['class-constructor', 'class-__proto__', 'class-prototype'].includes(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const className = value => typeof value === 'string' && value === value.normalize('NFKC').trim().replace(/\s+/g, ' ') && value.length >= 1 && value.length <= 96 && !/[\u0000-\u001f\u007f]/.test(value);
const learnerRef = value => typeof value === 'string' && /^l-[a-f0-9]{24}$/.test(value);
const transientCode = error => ['unavailable', 'deadline-exceeded', 'resource-exhausted', 'network-request-failed', 'network-error'].includes(String(error?.code ?? '').replace(/^functions\//, ''));
const callableCode = error => String(error?.code ?? '').replace(/^functions\//, '');
const frozen = value => Object.freeze(value);
const request = () => `request-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
const noMemberships = () => frozen([]);

export function normalizeJoinCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${codeAlphabet}]{8}$`).test(normalized) ? normalized : null;
}

function membership(value) {
  if (!exact(value, ['contractVersion', 'classId', 'className', 'membershipStatus', 'joinedAt', 'updatedAt']) || value.contractVersion !== '1' || !classId(value.classId) || !className(value.className) || !['active', 'left'].includes(value.membershipStatus) || !timestamp(value.joinedAt) || !timestamp(value.updatedAt) || Date.parse(value.joinedAt) > Date.parse(value.updatedAt)) throw new Error('Protected class membership is malformed.');
  return frozen({ classId: value.classId, className: value.className, membershipStatus: value.membershipStatus, joinedAt: value.joinedAt, updatedAt: value.updatedAt });
}

export function validateStudentMemberships(value) {
  if (!exact(value, ['contractVersion', 'classes']) || value.contractVersion !== '1' || !Array.isArray(value.classes)) throw new Error('Protected class memberships are malformed.');
  const memberships = value.classes.map(membership); const seen = new Set();
  if (memberships.some(item => seen.has(item.classId) || !seen.add(item.classId))) throw new Error('Protected class memberships are malformed.');
  return frozen(memberships);
}

export function validateMembershipAcknowledgement(value, operation) {
  const keys = operation === 'joinClass' ? ['contractVersion', 'operation', 'accepted', 'class', 'learnerRef'] : ['contractVersion', 'operation', 'accepted', 'class'];
  const item = membership(value?.class);
  if (!exact(value, keys) || value.contractVersion !== '1' || value.operation !== operation || value.accepted !== true || (operation === 'joinClass' && (!learnerRef(value.learnerRef) || item.membershipStatus !== 'active')) || (operation === 'leaveClass' && item.membershipStatus !== 'left')) throw new Error('Protected class acknowledgement is malformed.');
  return frozen({ operation, class: item });
}

export function createStudentClassController({ client, render = () => {} }) {
  let generation = 0; let subscriptionGeneration = 0; let started = false; let currentUser = null; let unsubscribe = () => {}; let snapshot = null; let snapshotUid = null; let pending = null;
  let state = frozen({ mode: client?.mode === 'disabled' ? 'disabled' : 'signed-out', memberships: noMemberships(), message: 'Sign in to view or join a class.', busy: false, pending: false, clearJoinCode: false });
  const emit = patch => { state = frozen({ ...state, ...patch, memberships: patch.memberships ?? state.memberships, pending: patch.pending ?? Boolean(pending), clearJoinCode: patch.clearJoinCode === true }); render(state, dispatch); };
  const current = token => started && token.generation === generation && currentUser?.uid === token.uid;
  const currentUserMatches = uid => started && currentUser?.uid === uid;
  const clearProtected = (mode, message) => { generation += 1; currentUser = null; snapshot = null; snapshotUid = null; pending = null; emit({ mode, memberships: noMemberships(), message, busy: false, pending: false, clearJoinCode: true }); };
  const pendingMessage = () => pending?.operation === 'joinClass' ? 'We are confirming your previous class request. Refresh when you are back online.' : 'We are confirming your previous class change. Refresh when you are back online.';
  const holdPending = memberships => emit({ mode: 'pending-reconciliation', memberships: memberships ?? (snapshotUid === currentUser?.uid ? snapshot ?? noMemberships() : noMemberships()), message: pendingMessage(), busy: false, pending: true, clearJoinCode: pending?.operation === 'joinClass' });
  const acknowledgementMatches = memberships => pending?.acknowledgement && memberships.some(item => item.classId === pending.acknowledgement.class.classId && item.membershipStatus === pending.acknowledgement.class.membershipStatus);
  const clearPendingAsError = message => { pending = null; snapshot = null; snapshotUid = null; emit({ mode: 'error', memberships: noMemberships(), message, busy: false, pending: false, clearJoinCode: true }); };

  async function fetchMemberships({ pendingRefresh = false, clearJoinCode = false } = {}) {
    const token = { generation: ++generation, uid: currentUser?.uid };
    if (!token.uid) { clearProtected('signed-out', 'Sign in to view or join a class.'); return null; }
    emit({ mode: pendingRefresh ? 'pending-reconciliation' : 'loading', memberships: pendingRefresh && snapshotUid === token.uid ? snapshot ?? noMemberships() : state.memberships, message: pendingRefresh ? pendingMessage() : 'Loading your classes…', busy: true, pending: Boolean(pending), clearJoinCode });
    try {
      const memberships = validateStudentMemberships(await client.listStudentMemberships());
      if (!current(token)) return null;
      snapshot = memberships; snapshotUid = token.uid;
      return memberships;
    } catch (error) {
      if (!current(token)) return null;
      if (pending && transientCode(error) && snapshot && snapshotUid === token.uid) { holdPending(snapshot); return null; }
      if (pending) { clearPendingAsError('We could not confirm your class change. Refresh your class list before trying again.'); return null; }
      if (transientCode(error) && snapshot && snapshotUid === token.uid) { emit({ mode: 'stale', memberships: snapshot, message: 'Showing your last confirmed classes while we reconnect.', busy: false, pending: false }); return null; }
      snapshot = null; snapshotUid = null;
      emit({ mode: 'error', memberships: noMemberships(), message: 'We could not load your classes right now. Practice is still available on this device.', busy: false, pending: false, clearJoinCode: true }); return null;
    }
  }

  async function replayPending(uid) {
    if (!pending || !currentUserMatches(uid)) return;
    const operation = pending.operation; const payload = pending.payload;
    try {
      const acknowledgement = validateMembershipAcknowledgement(await client[operation](payload), operation);
      if (!currentUserMatches(uid) || !pending || pending.payload !== payload) return;
      pending = { ...pending, acknowledgement, needsReplay: false };
      const memberships = await fetchMemberships({ pendingRefresh: true });
      if (!currentUserMatches(uid) || !pending || pending.payload !== payload) return;
      if (memberships && acknowledgementMatches(memberships)) { pending = null; emit({ mode: 'ready', memberships, message: 'Your class list is up to date.', busy: false, pending: false, clearJoinCode: operation === 'joinClass' }); }
      else holdPending(memberships);
    } catch { if (currentUserMatches(uid)) holdPending(); }
  }

  async function reconcilePending() {
    if (!pending || !currentUser?.uid) return false;
    const uid = currentUser.uid; const original = pending;
    const memberships = await fetchMemberships({ pendingRefresh: true });
    if (!currentUserMatches(uid) || pending !== original) return false;
    if (!memberships) return false;
    if (acknowledgementMatches(memberships)) { const operation = pending.operation; pending = null; emit({ mode: 'ready', memberships, message: 'Your class list is up to date.', busy: false, pending: false, clearJoinCode: operation === 'joinClass' }); return true; }
    await replayPending(uid); return !pending;
  }

  async function refresh({ clearJoinCode = false } = {}) {
    if (pending) return reconcilePending();
    const memberships = await fetchMemberships({ clearJoinCode });
    if (memberships && currentUser?.uid) emit({ mode: 'ready', memberships, message: 'Your active and prior classes are shown here.', busy: false, pending: false });
    return Boolean(memberships);
  }

  async function startOperation(operation, payload) {
    if (!currentUser?.uid) return clearProtected('signed-out', 'Sign in to manage your classes.');
    if (pending) return holdPending();
    const uid = currentUser.uid; pending = { operation, payload, acknowledgement: null, needsReplay: false };
    emit({ mode: operation === 'joinClass' ? 'joining' : 'leaving', message: operation === 'joinClass' ? 'Joining class…' : 'Leaving class…', busy: true, pending: true, clearJoinCode: operation === 'joinClass' });
    try {
      const acknowledgement = validateMembershipAcknowledgement(await client[operation](payload), operation);
      if (!currentUserMatches(uid) || !pending || pending.payload !== payload) return;
      pending = { ...pending, acknowledgement };
    } catch (error) {
      if (!currentUserMatches(uid) || !pending || pending.payload !== payload) return;
      if (operation === 'joinClass' && callableCode(error) === 'failed-precondition') {
        pending = null;
        emit({ mode: 'ready', memberships: snapshotUid === uid ? snapshot ?? noMemberships() : noMemberships(), message: 'We could not join that class. Check the code and try again.', busy: false, pending: false, clearJoinCode: true });
        return;
      }
      if (!transientCode(error)) {
        clearPendingAsError(operation === 'joinClass' ? 'We could not complete that class request. Refresh your class list before trying again.' : 'We could not leave that class. Refresh your class list before trying again.');
        return;
      }
      pending = { ...pending, needsReplay: true };
    }
    if (currentUserMatches(uid) && pending?.payload === payload) await reconcilePending();
  }

  const dispatch = async action => {
    if (action?.type === 'retry') { if (state.busy) return; return refresh(); }
    if (action?.type === 'join') {
      const joinCode = normalizeJoinCode(action.joinCode);
      if (!joinCode) return emit({ mode: pending ? 'pending-reconciliation' : state.mode, message: 'Enter the eight-character class code.', busy: false, pending: Boolean(pending), clearJoinCode: true });
      if (pending) return holdPending();
      return startOperation('joinClass', { requestId: action.requestId ?? request(), joinCode });
    }
    if (action?.type === 'leave' && classId(action.classId)) { if (pending) return holdPending(); return startOperation('leaveClass', { requestId: action.requestId ?? request(), classId: action.classId }); }
  };
  return frozen({
    get state() { return state; },
    start() {
      if (started) return;
      started = true;
      if (client?.mode === 'disabled') return emit({ mode: 'disabled', memberships: noMemberships(), message: 'Class features will be available when the approved pilot begins.', busy: false, pending: false, clearJoinCode: true });
      if (client?.mode === 'error') return emit({ mode: 'disabled', memberships: noMemberships(), message: 'Class features are unavailable until sign-in is working.', busy: false, pending: false, clearJoinCode: true });
      const subscription = ++subscriptionGeneration;
      unsubscribe = client?.subscribeAuthState?.((user, error) => {
        if (!started || subscription !== subscriptionGeneration) return;
        if (error) return clearProtected('error', 'We could not check sign-in. Practice is still available on this device.');
        if (!user) return clearProtected('signed-out', 'Sign in to view or join a class.');
        if (currentUser?.uid !== user.uid) {
          generation += 1; snapshot = null; snapshotUid = null; pending = null;
          emit({ mode: 'loading', memberships: noMemberships(), message: 'Loading your classes…', busy: true, pending: false, clearJoinCode: true });
          currentUser = { uid: user.uid }; refresh({ clearJoinCode: true });
        }
      }) ?? (() => {});
    },
    stop() {
      if (!started) return;
      started = false; generation += 1; subscriptionGeneration += 1; unsubscribe(); unsubscribe = () => {}; currentUser = null; snapshot = null; snapshotUid = null; pending = null;
      emit({ mode: 'signed-out', memberships: noMemberships(), message: 'Sign in to view or join a class.', busy: false, pending: false, clearJoinCode: true });
    },
    dispatch
  });
}
