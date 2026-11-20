/*
 * The Cinema page's "Jellyfin library" choices (core/feature-config-spec.js, cinema.jellyfin_library_id).
 *
 * The generic settings page reads a select's options synchronously, so this keeps a cached list and refreshes it in
 * the background (every 5 minutes, on first use). The first value is always "Every video library" (''), stored as
 * NULL, which is what /movie did before a library could be chosen. If Jellyfin cannot be reached, the last list stays.
 */
import { activityConfig } from '../config.js';
import { createJellyfinMedia } from './jellyfin-media.js';

const ALL = Object.freeze({ value: '', label: 'Every video library' });
let cache = { options: [ALL], at: 0, loading: null };

function refresh() {
    if (cache.loading) return cache.loading;
    cache.loading = (async () => {
        try {
            const cfg = activityConfig();
            if (!cfg.jellyfin.base || !cfg.jellyfin.apiKey) return;
            const libs = await createJellyfinMedia({ cfg }).listLibraries({ fresh: true });
            cache.options = [ALL, ...libs.map((l) => ({ value: l.id, label: l.name }))];
        } catch { /* keep the last list */ } finally {
            cache.at = Date.now();
            cache.loading = null;
        }
    })();
    return cache.loading;
}

/** The current options (never empty); starts a refresh when the list is older than 5 minutes. */
export function jellyfinLibraryOptions() {
    // Never from a test run (node --test sets NODE_TEST_CONTEXT): the spec is read by many tests.
    if (Date.now() - cache.at > 300_000 && !process.env.NODE_TEST_CONTEXT) refresh().catch(() => {});
    return cache.options;
}

export async function refreshJellyfinLibraryOptions() {
    await refresh();
    return cache.options;
}
