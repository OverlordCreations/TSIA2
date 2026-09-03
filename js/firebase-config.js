// This file is intentionally safe to ship. Firebase web configuration is an
// identifier, not a credential; nevertheless the integration starts disabled
// until a district-approved project is explicitly configured.
export const firebaseConfig = Object.freeze({
  enabled: false,
  projectId: '',
  apiKey: '',
  authDomain: '',
  appId: '',
  appCheckSiteKey: '',
  functionsRegion: 'us-central1'
});

export const firebaseSdkVersion = '12.18.0';

export function firebaseIsConfigured(config = firebaseConfig) {
  return Boolean(config.enabled && config.projectId && config.apiKey && config.authDomain && config.appId && config.appCheckSiteKey);
}
