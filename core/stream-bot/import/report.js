/*
 * Stream bot import: the mapping report shown on /stream/bot/import and kept with each import.
 *
 *   reportOf(plan, { categories }) → { counts, groups: { as_is, changed, skipped }, gaps, checklist, obs, media }
 * Items are cut down to what the page shows (no automation step lists, no viewer rows, no quotes text).
 * Groups: imported as they were, imported with changes (and what changed), not imported (and why).
 */
import { CATEGORIES } from './catalog.js';
import { SOURCE_LABEL } from './mapper.js';

export const TARGET_LABEL = Object.freeze({
    channel_command: 'Channel command', automation: 'Stream bot automation', channel_timer: 'Kick timed message', variable: 'Counter (channel value)',
    reward_definition: 'Saved reward', viewer_values: 'Viewer values', bot_timer: 'Stream bot timer',
    pending_words: 'Banned words, saved but not applied',
});
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

export function itemView(it, extra = {}) {
    return {
        category: it.category, categoryLabel: CAT_LABEL[it.category] || it.category, source: it.source, sourceLabel: SOURCE_LABEL[it.source] || it.source,
        kind: it.kind, sourceId: String(it.sourceId).slice(0, 191), name: String(it.name || '').slice(0, 150), status: it.status,
        why: (it.why || []).map((w) => String(w).slice(0, 400)).slice(0, 12), target: it.target ? TARGET_LABEL[it.target.system] || it.target.system : null, ...extra,
    };
}

export function reportOf(plan, { categories = null } = {}) {
    const pickCat = (it) => !categories || categories.includes(it.category);
    const groups = { as_is: [], changed: [], skipped: [] };
    const counts = {};
    for (const it of plan.items) {
        if (!pickCat(it)) continue;
        groups[it.status].push(itemView(it));
        const c = (counts[it.category] ||= { label: CAT_LABEL[it.category] || it.category, as_is: 0, changed: 0, skipped: 0 });
        c[it.status]++;
    }
    return {
        counts, groups,
        gaps: plan.gaps.map((g) => ({ key: g.key, label: g.label, phase: g.phase, why: g.why, count: g.count, bySource: g.bySource, examples: g.examples })),
        checklist: plan.checklist, obs: plan.obs, speech: plan.speech || [],
        media: plan.media.map((m) => ({ path: String(m.path).slice(0, 300), kind: m.kind, usedBy: m.usedBy, source: m.source, size: m.size ?? null, status: m.status ?? null })),
    };
}

/** JSON for a <script type="application/json"> block: "<" is escaped, so the text cannot close the element. */
export const pageJson = (v) => JSON.stringify(v ?? null).replace(/</g, '\\u003c');

export default { reportOf, itemView, pageJson, TARGET_LABEL };
