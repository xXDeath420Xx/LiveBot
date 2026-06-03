import fetch from 'node-fetch';

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/stream/connect/twitch/callback`;
const SCOPES = 'channel:read:stream_key';
export const TWITCH_INGEST = 'rtmp://ingest.global-contribute.live-video.net/app';

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES, state,
  });
  return `https://id.twitch.tv/oauth2/authorize?${params}`;
}

export async function handleCallback(code, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const tokenRes = await fetchFn('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) throw new Error('twitch token exchange failed');
  const userRes = await fetchFn('https://api.twitch.tv/helix/users', {
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Client-Id': CLIENT_ID },
  });
  const u = (await userRes.json()).data?.[0];
  if (!u) throw new Error('twitch user fetch failed');
  if (Array.isArray(tokens.scope)) tokens.scope = tokens.scope.join(' ');
  return { platformUserId: u.id, username: u.login, tokens };
}

export async function connectDestination(account, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const res = await fetchFn(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${account.platformUserId}`, {
    headers: { Authorization: `Bearer ${account.accessToken}`, 'Client-Id': CLIENT_ID },
  });
  if (!res.ok) throw new Error('twitch stream key fetch failed (' + res.status + ')');
  const key = (await res.json()).data?.[0]?.stream_key;
  if (!key) throw new Error('twitch returned no stream key');
  return { name: `Twitch (${account.platformUsername})`, resolution: 'static', rtmp_url: TWITCH_INGEST, dest_stream_key: key, config: null };
}

// Static platform: resolver returns stored values, but provide a passthrough for completeness.
export async function resolveAtGoLive(account, cfg) {
  return { rtmp_url: cfg?.rtmp_url || TWITCH_INGEST, key: cfg?.key || '' };
}
