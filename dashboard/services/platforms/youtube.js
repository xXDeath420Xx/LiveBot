import fetch from 'node-fetch';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/stream/connect/youtube/callback`;
const SCOPE = 'https://www.googleapis.com/auth/youtube';
const API = 'https://www.googleapis.com/youtube/v3';

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function handleCallback(code, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }),
  });
  const tokens = await res.json();
  if (!tokens.access_token) throw new Error('youtube token exchange failed');
  let username = 'youtube', platformUserId = null;
  try {
    const ch = await fetchFn(`${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const c = (await ch.json()).items?.[0];
    if (c) { username = c.snippet?.title || 'youtube'; platformUserId = c.id; }
  } catch { /* best effort */ }
  tokens.expires_at = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
  return { platformUserId, username, tokens };
}

async function refreshAccessToken(account, fetchFn) {
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: account.refreshToken, grant_type: 'refresh_token' }),
  });
  const t = await res.json();
  if (!t.access_token) throw new Error('youtube token refresh failed');
  return t.access_token;
}

export async function connectDestination(account) {
  return { name: `YouTube (${account.platformUsername})`, resolution: 'dynamic', rtmp_url: '', dest_stream_key: '',
    config: { title: 'Live with CertiFried', privacy: 'public' } };
}

export async function resolveAtGoLive(account, cfg = {}, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const at = opts.refreshFn ? await opts.refreshFn(account) : await refreshAccessToken(account, fetchFn);
  const auth = { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' };

  const streamRes = await fetchFn(`${API}/liveStreams?part=snippet,cdn,contentDetails`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ snippet: { title: cfg.title || 'CertiFried Stream' },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' }, contentDetails: { isReusable: false } }),
  });
  if (!streamRes.ok) throw new Error('yt liveStreams.insert ' + streamRes.status);
  const stream = await streamRes.json();
  const ing = stream.cdn?.ingestionInfo;
  if (!ing) throw new Error('yt missing ingestionInfo');

  const bRes = await fetchFn(`${API}/liveBroadcasts?part=snippet,status,contentDetails`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ snippet: { title: cfg.title || 'CertiFried Stream', scheduledStartTime: new Date().toISOString() },
      status: { privacyStatus: cfg.privacy || 'public', selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true } }),
  });
  if (!bRes.ok) throw new Error('yt liveBroadcasts.insert ' + bRes.status);
  const broadcast = await bRes.json();

  const bindRes = await fetchFn(`${API}/liveBroadcasts/bind?id=${broadcast.id}&streamId=${stream.id}&part=id,contentDetails`,
    { method: 'POST', headers: auth });
  if (!bindRes.ok) throw new Error('yt liveBroadcasts.bind ' + bindRes.status);

  return { rtmp_url: ing.ingestionAddress, key: ing.streamName };
}
