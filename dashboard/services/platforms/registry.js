import * as twitch from './twitch.js';
import * as kick from './kick.js';
import * as youtube from './youtube.js';
import * as facebook from './facebook.js';

// oauthConnect:false => platform has no stream-key API, so OAuth can't auto-fill
// a key; it's offered as a manual preset instead (no "Connect" OAuth button).
export const PLATFORM_META = {
  twitch:   { platform: 'twitch',   label: 'Twitch',   mode: 'static',  reviewGated: false, oauthConnect: true,  adapter: twitch },
  kick:     { platform: 'kick',     label: 'Kick',     mode: 'static',  reviewGated: false, oauthConnect: false, adapter: kick },
  youtube:  { platform: 'youtube',  label: 'YouTube',  mode: 'dynamic', reviewGated: true,  oauthConnect: true,  adapter: youtube },
  facebook: { platform: 'facebook', label: 'Facebook', mode: 'dynamic', reviewGated: true,  oauthConnect: true,  adapter: facebook },
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
