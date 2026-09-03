import { isValidatedStudentSnapshotMerge } from './authoritative-sync.js';

const safeCopy = Object.freeze({
  'local-only': 'Practice is saved on this device. Cloud progress is not enabled yet.',
  loading: 'Checking your protected progress. You can keep practicing.',
  synced: 'Protected progress is up to date. Your next practice choice stays in your control.',
  stale: 'We could not refresh protected progress. Your practice on this device is still available.',
  blocked: 'Protected progress is not available for this account. You can keep practicing on this device.'
});
const safeDetail = value => Object.freeze({ eventCount: Array.isArray(value?.events) ? value.events.length : 0, progressCount: value?.progress && typeof value.progress === 'object' ? Object.keys(value.progress).length : 0, resumeCandidate: value?.resumeCandidate ?? null });

// Presentation-neutral and deliberately non-wired. It accepts only the
// adapter's validated merge result, never a raw callable response.
export function createStudentSnapshotStatusController({ client, adapter = null, syncQueue = async () => {}, onChange = () => {} } = {}) {
  let generation = 0; let active = false; let state = 'local-only';
  const emit = (next, detail = null) => { state = next; onChange(Object.freeze({ state, message: safeCopy[next], detail })); };
  const current = token => active && token === generation;
  return Object.freeze({
    get state() { return state; },
    start({ uid, releaseId }) {
      generation += 1; active = true; const token = generation;
      if (client?.mode !== 'ready' || typeof adapter?.loadAndMerge !== 'function' || typeof uid !== 'string' || typeof releaseId !== 'string') { emit('local-only'); return Promise.resolve(null); }
      emit('loading');
      return Promise.resolve().then(() => syncQueue({ uid, releaseId })).then(() => current(token) ? adapter.loadAndMerge() : null).then(result => {
        if (!current(token)) return null;
        if (result?.remoteAccepted !== true || !isValidatedStudentSnapshotMerge(result, { uid, releaseId })) { emit('stale'); return null; }
        emit('synced', safeDetail(result)); return result;
      }).catch(error => { if (!current(token)) return null; const blocked = ['permission-denied', 'failed-precondition', 'unauthenticated'].some(code => String(error?.code ?? '').includes(code)); emit(blocked ? 'blocked' : 'stale'); return null; });
    },
    stop() { generation += 1; active = false; emit('local-only'); }
  });
}
export const studentSnapshotStatusCopy = safeCopy;
