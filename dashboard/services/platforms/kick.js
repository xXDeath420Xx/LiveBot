import fetch from 'node-fetch';

const CLIENT_ID = process.env.KICK_CLIENT_ID;
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/stream/connect/kick/callback`;
const SCOPES = 'user:read';
export const KICK_INGEST = 'rtmps://fa723fc1b171.global-contribute.live-video.net/app';

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES, state,
  });
  return `https://id.kick.com/oauth/authorize?${params}`;
}

export async function handleCallback(code, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const res = await fetchFn('https://id.kick.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }),
  });
  const tokens = await res.json();
  if (!tokens.access_token) throw new Error('kick token exchange failed');
  let username = 'kick', platformUserId = null;
  try {
    const me = await fetchFn('https://api.kick.com/public/v1/users', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const u = (await me.json()).data?.[0];
    if (u) { username = u.name || u.username || 'kick'; platformUserId = String(u.user_id || u.id || ''); }
  } catch { /* identity is best-effort; Kick API shapes vary */ }
  return { platformUserId, username, tokens };
}

export async function connectDestination(account) {
  return { name: `Kick (${account.platformUsername || 'account'})`, resolution: 'static', rtmp_url: KICK_INGEST, dest_stream_key: '', needsKey: true, config: null };
}

export async function resolveAtGoLive(account, cfg) {
  return { rtmp_url: cfg?.rtmp_url || KICK_INGEST, key: cfg?.key || '' };
}
