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

// itemId is effectively user-controlled (a /movie 'title' option value can be any
// string the client sends, not only an autocomplete pick). Jellyfin item ids are
// alphanumeric (32-char hex). Reject anything else BEFORE it reaches a URL path
// segment or the ffmpeg filtergraph — neutralizes URL- and filter-injection.
const ITEM_ID_RE = /^[A-Za-z0-9]{1,64}$/;
export function isValidItemId(itemId) {
  return typeof itemId === 'string' && ITEM_ID_RE.test(itemId);
}
function assertItemId(itemId) {
  if (!isValidItemId(itemId)) throw new Error('Invalid Jellyfin item id');
  return itemId;
}

/** Build a static (direct-play, NO Jellyfin transcode) stream URL. */
export function streamUrl(itemId, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  return `${base}/Videos/${encodeURIComponent(assertItemId(itemId))}/stream?static=true&api_key=${apiKey}`;
}

/**
 * URL for a single subtitle track delivered as a standalone .srt (small + fast).
 * Burning from this avoids re-opening the whole remote video in the ffmpeg
 * subtitles filter. mediaSourceId == itemId for single-source library items.
 */
export function subtitleUrl(itemId, streamIndex, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  const id = encodeURIComponent(assertItemId(itemId));
  return `${base}/Videos/${id}/${id}/Subtitles/${Number(streamIndex)}/0/Stream.srt?api_key=${apiKey}`;
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

/**
 * Search the library for Movie / Series / Season / Episode items matching a term.
 * Labels are formatted per type so the autocomplete picker is unambiguous:
 *   Movie   → "The Matrix (1999)"
 *   Series  → "Futurama (Show · 12 seasons)"
 *   Season  → "Futurama · Season 1 (9 ep)"       ← NEW: series matches auto-expand
 *   Episode → "Futurama · S01E02 · The Series Has Landed"
 *
 * When a Series matches, its seasons are pulled in with the same call so the
 * user can pick a season directly from the type-ahead instead of going through
 * a follow-up menu. We limit expansion to the top 2 series to leave room for
 * movies + episodes in Discord's 25-option autocomplete cap. Any resulting
 * duplicates (same id — Jellyfin can return the same series more than once for
 * a broad search) collapse to a single entry.
 */
export async function search(term, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  const url =
    `${base}/Items?searchTerm=${encodeURIComponent(term)}` +
    `&IncludeItemTypes=Movie,Series,Episode&Recursive=true&Limit=25` +
    `&Fields=ProductionYear,ParentIndexNumber,IndexNumber,SeriesName,ChildCount&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin search ${res.status}`);
  const data = await res.json();
  const items = data.Items || [];

  // De-dup series ids — Jellyfin sometimes returns the same series multiple times
  // (broad search + duplicate library entries). Keep only the first hit for each
  // id; the season list is fetched once per unique id below.
  const seen = new Set();
  const primary = [];
  for (const i of items) {
    if (seen.has(i.Id)) continue;
    seen.add(i.Id);
    primary.push(i);
  }

  // Pull seasons (with episode counts) for up to 2 top series matches. Fan out
  // in parallel to keep autocomplete under Discord's ~3 s window; skip any
  // season whose episode count is zero, keep null-count seasons (unknown).
  const seriesToExpand = primary.filter((i) => i.Type === 'Series').slice(0, 2);
  const seasonLists = await Promise.all(seriesToExpand.map(async (s) => {
    try {
      const seasons = await getSeasons(s.Id, overrides, { withCounts: true });
      return { series: s, seasons: seasons.filter((sn) => sn.episodeCount == null || sn.episodeCount > 0) };
    } catch {
      return { series: s, seasons: [] };
    }
  }));

  const out = [];
  for (const i of primary) {
    let name;
    if (i.Type === 'Episode') {
      const s = i.ParentIndexNumber != null ? String(i.ParentIndexNumber).padStart(2, '0') : '??';
      const e = i.IndexNumber != null ? String(i.IndexNumber).padStart(2, '0') : '??';
      name = `${i.SeriesName || 'Show'} · S${s}E${e} · ${i.Name}`;
    } else if (i.Type === 'Series') {
      const seasonHit = seasonLists.find((s) => s.series.Id === i.Id);
      const sc = seasonHit ? seasonHit.seasons.length : (i.ChildCount ?? 0);
      name = sc > 0
        ? `${i.Name} (Show · ${sc} season${sc === 1 ? '' : 's'})`
        : `${i.Name} (Show — no seasons)`;
    } else {
      name = i.ProductionYear ? `${i.Name} (${i.ProductionYear})` : i.Name;
    }
    out.push({ id: i.Id, name, type: i.Type });
    // Immediately after the Series entry, splice in its seasons so they group
    // visually in the dropdown.
    if (i.Type === 'Series') {
      const seasonHit = seasonLists.find((s) => s.series.Id === i.Id);
      if (seasonHit) {
        for (const sn of seasonHit.seasons) {
          const suffix = sn.episodeCount != null ? ` (${sn.episodeCount} ep)` : '';
          out.push({
            id: sn.id,
            name: `${i.Name} · Season ${sn.seasonNumber}${suffix}`,
            type: 'Season',
            // Carry parent series id so the command handler can render "S#E# · title"
            // headers without an extra API round-trip.
            seriesId: i.Id,
          });
        }
      }
    }
  }

  // Discord caps autocomplete at 25 entries. Prioritize: keep the first 25
  // preserving the interleaved order (series → its seasons → next series → …).
  return out.slice(0, 25);
}

/**
 * List seasons of a Series (for the follow-up "which season?" picker).
 * Note: Jellyfin's /Shows/{id}/Seasons does NOT populate ChildCount even with
 * Fields=ItemCounts, so episodeCount is set from a follow-up /Items count
 * only if the caller asks for it via { withCounts:true }. Without it, we
 * return episodeCount=null and let downstream code decide whether a follow-up
 * roundtrip is worth the latency.
 */
export async function getSeasons(seriesId, overrides = {}, opts = {}) {
  const { base, apiKey } = cfg(overrides);
  const url = `${base}/Shows/${encodeURIComponent(assertItemId(seriesId))}/Seasons?api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin getSeasons ${res.status}`);
  const data = await res.json();
  const seasons = (data.Items || []).map((s) => ({
    id: s.Id,
    seasonNumber: s.IndexNumber ?? 0,
    name: s.Name || `Season ${s.IndexNumber ?? '?'}`,
    episodeCount: null,
  }));

  // Optionally hydrate episodeCount per season (parallel /Items counts). Only
  // worth it for callers that need to display "(N ep)" next to each season.
  if (opts.withCounts && seasons.length) {
    await Promise.all(seasons.map(async (sn) => {
      try {
        // Reliable per-season count. The flat Items?parentId=<seasonId> count
        // returns 0 when a show has DUPLICATE series records (episodes bind to one
        // series' season while the flat parent index is ambiguous) — which silently
        // hid every season as "no episodes". The series-scoped Episodes endpoint
        // counts correctly.
        const cu = `${base}/Shows/${encodeURIComponent(assertItemId(seriesId))}/Episodes` +
          `?seasonId=${encodeURIComponent(sn.id)}&EnableTotalRecordCount=true&Limit=0&api_key=${apiKey}`;
        const cr = await fetch(cu, { headers: { Accept: 'application/json' } });
        if (cr.ok) {
          const cd = await cr.json();
          sn.episodeCount = cd.TotalRecordCount ?? 0;
        }
      } catch { /* leave episodeCount null */ }
    }));
  }
  return seasons;
}

/** List episodes in a Season (for the follow-up "which episode?" picker). */
export async function getEpisodes(seriesId, seasonId, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  const url = `${base}/Shows/${encodeURIComponent(assertItemId(seriesId))}/Episodes` +
    `?SeasonId=${encodeURIComponent(assertItemId(seasonId))}` +
    `&Fields=Overview&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin getEpisodes ${res.status}`);
  const data = await res.json();
  return (data.Items || []).map((e) => ({
    id: e.Id,
    episodeNumber: e.IndexNumber ?? 0,
    seasonNumber: e.ParentIndexNumber ?? 0,
    name: e.Name || `Episode ${e.IndexNumber ?? '?'}`,
  }));
}

/**
 * ALL episodes of a series across every season, ordered by (season, episode).
 * Powers "Play whole show" and "Play to end of show" (season rollover). Special
 * seasons (seasonNumber 0) are excluded from binge order — they're not part of
 * the main sequential watch.
 */
export async function getSeriesEpisodes(seriesId, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  // Series-scoped endpoint (reliable; avoids the duplicate-series double-count the
  // flat Items?parentId=<seriesId>&Recursive=true query produces). Returns episodes
  // in aired order across all seasons; we re-sort below defensively.
  const url = `${base}/Shows/${encodeURIComponent(assertItemId(seriesId))}/Episodes` +
    `?Fields=ParentIndexNumber,IndexNumber&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin getSeriesEpisodes ${res.status}`);
  const data = await res.json();
  const eps = (data.Items || []).map((e) => ({
    id: e.Id,
    episodeNumber: e.IndexNumber ?? 0,
    seasonNumber: e.ParentIndexNumber ?? 0,
    name: e.Name || `Episode ${e.IndexNumber ?? '?'}`,
  })).filter((e) => e.seasonNumber > 0); // skip specials from the binge sequence
  // Defensive: SortBy should already order these, but guarantee it.
  eps.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  return eps;
}

/**
 * Browse the library by type (Movie or Series), alphabetically, paginated 25 at
 * a time — powers the theater panel's click-only Browse dropdown (Discord can't
 * do type-ahead search inside a component, so we page through real titles).
 * Returns { items:[{id,name,type}], total, page, pages }.
 */
export async function browseLibrary(kind, page = 0, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  const type = kind === 'series' ? 'Series' : 'Movie';
  const limit = 25;
  const start = Math.max(0, page) * limit;
  const url = `${base}/Items?IncludeItemTypes=${type}&Recursive=true` +
    `&SortBy=SortName&SortOrder=Ascending&Fields=ProductionYear` +
    `&StartIndex=${start}&Limit=${limit}&EnableTotalRecordCount=true&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin browse ${res.status}`);
  const data = await res.json();
  const total = data.TotalRecordCount ?? (data.Items || []).length;
  const items = (data.Items || []).map((i) => ({
    id: i.Id,
    name: i.ProductionYear ? `${i.Name} (${i.ProductionYear})` : i.Name,
    type: i.Type,
  }));
  return { items, total, page: Math.max(0, page), pages: Math.max(1, Math.ceil(total / limit)) };
}

/** Fetch a single item with its MediaStreams for track selection. */
export async function getItem(itemId, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  // Jellyfin has no GET /Items/{id} (returns 400). Query the list endpoint by id
  // (same family as search) with Fields=MediaStreams and take the first result.
  // Include SeriesName + Parent/IndexNumber so callers can render
  // "Series · S##E## · Episode" headers without another round-trip.
  // SeriesId lets Season picks route directly to the episode picker.
  const url = `${base}/Items?ids=${encodeURIComponent(assertItemId(itemId))}` +
    `&Fields=MediaStreams,MediaSources,SeriesName,SeriesId,ParentIndexNumber,IndexNumber&Recursive=true&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin getItem ${res.status}`);
  const data = await res.json();
  const item = (data.Items || [])[0];
  if (!item) throw new Error('Jellyfin item not found');
  // Some library views nest streams under MediaSources; surface them at the top.
  if (!Array.isArray(item.MediaStreams) && item.MediaSources?.[0]?.MediaStreams) {
    item.MediaStreams = item.MediaSources[0].MediaStreams;
  }
  return item;
}
