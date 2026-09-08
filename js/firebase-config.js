// This file is intentionally safe to ship. Firebase web configuration is an
// identifier, not a credential. The Spark project supplies Google identity
// only in the owner-evaluation release; protected sync remains disabled until
// its separate paid-service/security gates are satisfied.
export const firebaseConfig = Object.freeze({
  enabled: true,
  authEnabled: true,
  syncEnabled: false,
  projectId: 'tsia2-test-prep-6f3d1',
  apiKey: 'AIzaSyB9gJIgUGIma8kWk4L_PW2wePl_IlHuymQ',
  authDomain: 'tsia2-test-prep-6f3d1.firebaseapp.com',
  appId: '1:486418419907:web:90b58495fa279b90ac5276',
  appCheckSiteKey: '',
  functionsRegion: 'us-central1'
});

export const firebaseSdkVersion = '12.18.0';

export function firebaseAuthIsConfigured(config = firebaseConfig) {
  return Boolean(config.enabled && config.authEnabled !== false && config.projectId && config.apiKey && config.authDomain && config.appId);
}

export function firebaseSyncIsConfigured(config = firebaseConfig) {
  return Boolean(firebaseAuthIsConfigured(config) && config.syncEnabled === true && config.appCheckSiteKey);
}

// Retain the old helper name for callers that only need to know whether the
// browser can load Firebase at all. Sync has an intentionally separate gate.
export function firebaseIsConfigured(config = firebaseConfig) {
  return firebaseAuthIsConfigured(config);
}
