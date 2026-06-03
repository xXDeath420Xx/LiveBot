import * as twitch from './twitch.js';
import * as kick from './kick.js';
import * as youtube from './youtube.js';
import * as facebook from './facebook.js';

// oauthConnect:false => no "Connect" OAuth button (manual preset only).
// keyApi:false => OAuth connects identity but the platform has no stream-key API,
// so the user still pastes their key (Kick): connect = identity + prefilled URL.
export const PLATFORM_META = {
  twitch:   { platform: 'twitch',   label: 'Twitch',   mode: 'static',  reviewGated: false, oauthConnect: true, keyApi: true,  adapter: twitch },
  kick:     { platform: 'kick',     label: 'Kick',     mode: 'static',  reviewGated: false, oauthConnect: true, keyApi: false, adapter: kick },
  youtube:  { platform: 'youtube',  label: 'YouTube',  mode: 'dynamic', reviewGated: true,  oauthConnect: true, keyApi: true,  adapter: youtube },
  facebook: { platform: 'facebook', label: 'Facebook', mode: 'dynamic', reviewGated: true,  oauthConnect: true, keyApi: true,  adapter: facebook },
};

export function getAdapter(platform) {
  const m = PLATFORM_META[platform];
  if (!m) throw new Error(`Unknown platform: ${platform}`);
  return m.adapter;
}

export function listConnectable({ enableGated } = { enableGated: false }) {
  return Object.values(PLATFORM_META)
    .filter(m => m.oauthConnect !== false)
    .filter(m => enableGated || !m.reviewGated)
    .map(m => ({ platform: m.platform, label: m.label, mode: m.mode }));
}
