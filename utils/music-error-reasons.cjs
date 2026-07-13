"use strict";

/**
 * Maps player error messages to user-friendly reasons.
 * Single source of truth — used by both index.js and dj-manager.
 */
function getPlayerErrorReason(errorMessage) {
  var msg = errorMessage || '';

  // discord-player internal errors (most common — wraps extractor failures)
  if (msg.includes('Could not extract stream'))               return 'Could not find a playable source for this track';

  // Bridge duration mismatch (e.g., SoundCloud serving a 30s preview of a 3-min Spotify track)
  if (msg.includes('Bridge duration mismatch'))               return 'Couldn’t find a full-length match for this track';

  // yt-dlp extractor errors
  if (msg.includes('Failed to get audio URL'))                return 'Could not retrieve audio (may be temporarily unavailable)';
  if (msg.includes('Failed to find audio for'))               return 'Could not find a playable version of this track';
  if (msg.includes('Cannot search for deleted/unavailable'))  return 'Track has been deleted or is unavailable';
  if (msg.includes('timed out') || msg.includes('timeout'))   return 'Request timed out \u2014 YouTube may be slow';
  if (msg.includes('confirm you\'re not a bot') || msg.includes('confirm your age')) return 'YouTube is rate-limiting requests \u2014 try again shortly';

  // YouTube content-policy errors
  if (msg.includes('Video unavailable'))                      return 'Video is no longer available';
  if (msg.includes('private'))                                return 'Video is private';
  if (msg.includes('age') || msg.includes('Sign in'))         return 'Video is age-restricted';
  if (msg.includes('account') && msg.includes('terminated'))  return 'The YouTube channel was terminated';
  if (msg.includes('Terms of Service') || msg.includes('ToS')) return 'Video removed for Terms of Service violation';
  if (msg.includes('copyright'))                              return 'Video removed due to copyright';
  if (msg.includes('country') || msg.includes('region'))      return 'Video is region-locked';

  return 'Unknown error';
}

module.exports = { getPlayerErrorReason: getPlayerErrorReason };
