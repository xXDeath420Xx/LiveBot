/*
 * Audio filters members can apply (/music filter, /music eq) and the Music page's "Audio filters"
 * allow-list (music_config.enabled_filters, a JSON array of filter names).
 *
 * No list saved, or an empty one, means every filter is allowed: that is how the page has always
 * behaved, and a server that never touched the section must not lose its filters. Ticking one or more
 * boxes limits members to those. Turning a filter OFF is always allowed, so one left on from before a
 * restriction can still be removed.
 *
 * Values are discord-player FFmpeg filter names. The labels match the Music page.
 */

export const MUSIC_FILTERS = Object.freeze([
    ['bassboost', 'Bass boost'], ['8D', '8D audio'], ['vaporwave', 'Vaporwave'], ['nightcore', 'Nightcore'],
    ['phaser', 'Phaser'], ['tremolo', 'Tremolo'], ['vibrato', 'Vibrato'], ['reverse', 'Reverse'],
    ['treble', 'Treble boost'], ['normalizer', 'Normaliser'], ['surrounding', 'Surround'], ['pulsator', 'Pulsator'],
    ['subboost', 'Sub boost'], ['karaoke', 'Karaoke'], ['flanger', 'Flanger'], ['gate', 'Gate'],
    ['haas', 'Haas'], ['mcompand', 'Compander'],
].map(([value, label]) => Object.freeze({ value, label })));

const BY_VALUE = new Map(MUSIC_FILTERS.map(f => [f.value.toLowerCase(), f]));

/** A known filter by name (case-insensitive), or null. */
export function findFilter(name) {
    return BY_VALUE.get(String(name ?? '').trim().toLowerCase()) || null;
}

/** The label for a filter name (falls back to the name). */
export function filterLabel(name) {
    return findFilter(name)?.label || String(name);
}

/**
 * The server's allow-list as filter names, or null when every filter is allowed.
 * Accepts the stored JSON text, an array, or nothing. Unknown names are dropped.
 */
export function allowedFilterNames(raw) {
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw); } catch { list = null; }
    }
    if (!Array.isArray(list)) return null;
    const names = [...new Set(list.map(findFilter).filter(Boolean).map(f => f.value))];
    return names.length ? names : null;
}

/** May members turn this filter on? (`allowed` from allowedFilterNames.) */
export function isFilterAllowed(name, allowed) {
    const f = findFilter(name);
    if (!f) return false;
    return !allowed || allowed.includes(f.value);
}

/** The filters to offer, as { value, label }, in page order. */
export function offeredFilters(allowed) {
    return MUSIC_FILTERS.filter(f => !allowed || allowed.includes(f.value));
}

/** Clean a dashboard submission into the stored JSON array text (only known names, page order). */
export function normaliseFilterSubmission(values) {
    const list = Array.isArray(values) ? values : (values ? [values] : []);
    const wanted = new Set(list.map(findFilter).filter(Boolean).map(f => f.value));
    return JSON.stringify(MUSIC_FILTERS.filter(f => wanted.has(f.value)).map(f => f.value));
}

export default { MUSIC_FILTERS, findFilter, filterLabel, allowedFilterNames, isFilterAllowed, offeredFilters, normaliseFilterSubmission };
