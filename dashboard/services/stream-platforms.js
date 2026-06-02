// Platform presets for the multicast UI. rtmpUrl is the base; the user supplies
// their per-platform stream key. 'custom' lets users target any RTMP endpoint.
export const PLATFORMS = {
  twitch:    { name: 'Twitch',          rtmpUrl: 'rtmp://ingest.global-contribute.live-video.net/app', keyPlaceholder: 'live_xxxxxxxxx_xxxxxxxx', helpUrl: 'https://dashboard.twitch.tv/settings/stream' },
  youtube:   { name: 'YouTube',         rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',                    keyPlaceholder: 'xxxx-xxxx-xxxx-xxxx-xxxx', helpUrl: 'https://studio.youtube.com' },
  kick:      { name: 'Kick',            rtmpUrl: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app', keyPlaceholder: 'sk_us-west-2_xxx', helpUrl: 'https://kick.com/dashboard/settings/stream' },
  trovo:     { name: 'Trovo',           rtmpUrl: 'rtmp://livepush.trovo.live/live',                    keyPlaceholder: 'live_xxxxxxxx', helpUrl: 'https://studio.trovo.live' },
  instagram: { name: 'Instagram',       rtmpUrl: 'rtmps://live-upload.instagram.com:443/rtmp',         keyPlaceholder: 'IGxxxxxxxxxx', helpUrl: 'https://www.instagram.com' },
  tiktok:    { name: 'TikTok',          rtmpUrl: 'rtmps://push.us.tiktokcdn.com/stream',               keyPlaceholder: 'stream-xxxxxxxxxx', helpUrl: 'https://www.tiktok.com/studio' },
  twitter:   { name: 'X (Twitter)',     rtmpUrl: 'rtmps://prod-video-pops-0.live.twitter.com:443/x',   keyPlaceholder: 'xxxxxxxx', helpUrl: 'https://media.x.com' },
  facebook:  { name: 'Facebook Gaming', rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp',           keyPlaceholder: 'FB-xxxxxxxx-x', helpUrl: 'https://www.facebook.com/live/producer' },
  custom:    { name: 'Custom RTMP',     rtmpUrl: '',                                                   keyPlaceholder: '', helpUrl: null }
};

export function getPreset(platform) {
  return PLATFORMS[platform] || null;
}

export function isKnownPlatform(platform) {
  return Object.prototype.hasOwnProperty.call(PLATFORMS, platform);
}
