// utils/jellyfin.js
// Dependency-free Jellyfin client (native fetch). Imported by BOTH the main bot
// (search/autocomplete/picker) and the cinema service (resolve stream URL).
// Config is read from env by default but overridable for testing.

function cfg(overrides = {}) {
  return {
    base: (overrides.base ?? process.env.JELLYFIN_URL ?? '').replace(/\/+$/, ''),
    apiKey: overrides.apiKey ?? process.env.JELLYFIN_API_KEY ?? '',
  };
}

/** Build a static (direct-play, NO Jellyfin transcode) stream URL. */
export function streamUrl(itemId, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  return `${base}/Videos/${itemId}/stream?static=true&api_key=${apiKey}`;
}

/** Split an item's MediaStreams into selectable audio + subtitle tracks. */
export function parseMediaStreams(item) {
  const streams = Array.isArray(item?.MediaStreams) ? item.MediaStreams : [];
  const pick = (type) =>
    streams
      .filter((s) => s.Type === type)
      .map((s) => ({
        index: s.Index,
        label: s.DisplayTitle || s.Language || `${type} ${s.Index}`,
      }));
  return { audio: pick('Audio'), subtitles: pick('Subtitle') };
}

/** Search the library for Movie/Episode items matching a term. */
export async function search(term, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  const url =
    `${base}/Items?searchTerm=${encodeURIComponent(term)}` +
    `&IncludeItemTypes=Movie,Episode&Recursive=true&Limit=25` +
    `&Fields=ProductionYear&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin search ${res.status}`);
  const data = await res.json();
  return (data.Items || []).map((i) => ({
    id: i.Id,
    name: i.ProductionYear ? `${i.Name} (${i.ProductionYear})` : i.Name,
    type: i.Type,
  }));
}

/** Fetch a single item with its MediaStreams for track selection. */
export async function getItem(itemId, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  const url = `${base}/Items/${itemId}?Fields=MediaStreams&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin getItem ${res.status}`);
  return res.json();
}
