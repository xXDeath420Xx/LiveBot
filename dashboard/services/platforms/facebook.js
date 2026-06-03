import fetch from 'node-fetch';

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/stream/connect/facebook/callback`;
const GRAPH = 'https://graph.facebook.com/v19.0';
const SCOPE = 'publish_video';

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: APP_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPE, state,
  });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
}

export async function handleCallback(code, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const tRes = await fetchFn(`${GRAPH}/oauth/access_token?` + new URLSearchParams({
    client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: REDIRECT_URI, code,
  }));
  const tokens = await tRes.json();
  if (!tokens.access_token) throw new Error('facebook token exchange failed');
  let username = 'facebook', platformUserId = 'me';
  try {
    const me = await fetchFn(`${GRAPH}/me?fields=id,name&access_token=${tokens.access_token}`);
    const u = await me.json();
    if (u.id) { platformUserId = u.id; username = u.name || 'facebook'; }
  } catch { /* best effort */ }
  tokens.expires_at = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
  return { platformUserId, username, tokens };
}

export async function connectDestination(account) {
  return { name: `Facebook (${account.platformUsername})`, resolution: 'dynamic', rtmp_url: '', dest_stream_key: '',
    config: { title: 'Live with CertiFried', target: 'me' } };
}

export async function resolveAtGoLive(account, cfg = {}, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const target = cfg.target || account.platformUserId || 'me';
  const res = await fetchFn(`${GRAPH}/${target}/live_videos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'LIVE_NOW', title: cfg.title || 'CertiFried Stream', access_token: account.accessToken }),
  });
  if (!res.ok) throw new Error('fb live_videos ' + res.status);
  const lv = await res.json();
  const url = lv.secure_stream_url || lv.stream_url;
  if (!url) throw new Error('fb missing stream_url');
  return { rtmp_url: url, key: '' };
}
