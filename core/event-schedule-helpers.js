import crypto from 'crypto';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Sunday 00:00 UTC of the week containing `date`. */
export function weekStartFor(date) {
    const d = new Date(date);
    const dow = d.getUTCDay(); // 0=Sun
    const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    return sunday;
}

/**
 * Expand events into concrete segments inside [weekStart, weekStart+7d).
 * - recurrence 'none': included iff start_time is in-window.
 * - recurrence 'weekly': materialized on recur_dow at recur_start_min..recur_end_min (UTC).
 * Returns flat segments: { start:number(ms), end:number(ms), title, emoji, categoryId, userId, source }.
 */
export function materializeWeek(events, weekStart) {
    const ws = weekStart.getTime();
    const we = ws + WEEK_MS;
    const out = [];
    for (const e of events) {
        if (e.recurrence === 'weekly' && e.recur_dow != null && e.recur_start_min != null) {
            const dayStart = ws + e.recur_dow * DAY_MS;
            const start = dayStart + e.recur_start_min * 60 * 1000;
            const end = e.recur_end_min != null ? dayStart + e.recur_end_min * 60 * 1000 : start + 60 * 60 * 1000;
            if (start >= ws && start < we) {
                out.push({ start, end, title: e.title, emoji: e.emoji ?? null, categoryId: e.category_id ?? null, userId: e.user_id, source: e.source ?? 'manual' });
            }
        } else if (e.start_time) {
            const start = new Date(e.start_time).getTime();
            if (start >= ws && start < we) {
                const end = e.end_time ? new Date(e.end_time).getTime() : start + 60 * 60 * 1000;
                out.push({ start, end, title: e.title, emoji: e.emoji ?? null, categoryId: e.category_id ?? null, userId: e.user_id, source: e.source ?? 'manual' });
            }
        }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
}

/** Group segments into ordered category sections; unknown category_id -> "Uncategorized". */
export function groupByCategory(segments, categories) {
    const byId = new Map(categories.map(c => [c.id, c]));
    const buckets = new Map(); // categoryId -> { name, sort, items }
    for (const s of segments) {
        const cat = byId.get(s.categoryId);
        const key = cat ? cat.id : '__uncat__';
        if (!buckets.has(key)) {
            buckets.set(key, { id: cat?.id ?? null, name: cat?.name ?? 'Uncategorized', emoji: cat?.emoji ?? null, color: cat?.color ?? '#7F8C8D', sort: cat?.sort_order ?? 9999, items: [] });
        }
        buckets.get(key).items.push(s);
    }
    return [...buckets.values()].sort((a, b) => a.sort - b.sort);
}

/** Stable content hash for change-detection. */
export function scheduleHash(segments) {
    const norm = segments.map(s => `${s.start}|${s.end}|${s.categoryId}|${s.title}|${s.userId ?? ''}`).sort();
    return crypto.createHash('sha256').update(norm.join('\n')).digest('hex');
}
