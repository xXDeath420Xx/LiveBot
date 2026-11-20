/*
 * Discord Activities: what the person who launched the Activity asked for.
 *
 * /movie (and its picker buttons) cannot hand data to the Activity it launches: LAUNCH_ACTIVITY carries none. So the
 * bot leaves an intent here, keyed by server and person, and the Activity takes it when that person opens it in that
 * server (POST /activity/api/token answers with it). Memory only (the bot and the dashboard are one process);
 * an intent lasts 10 minutes and is taken once.
 */
const TTL_MS = 10 * 60 * 1000;
const MAX = 5000;
const intents = new Map(); // `${guildId}:${userId}` -> { intent, at }

const key = (guildId, userId) => `${guildId}:${userId}`;

function sweep(now) {
    for (const [k, v] of intents) if (now - v.at > TTL_MS) intents.delete(k);
}

/**
 * intent: { kind: 'watch', itemId, audioIndex?, subIndex?, queue?: [{ itemId, label }], label? } or { kind: 'greenhouse' }
 */
export function setIntent(guildId, userId, intent, now = Date.now()) {
    if (!guildId || !userId || !intent || !['watch', 'greenhouse'].includes(intent.kind)) return false;
    if (intents.size >= MAX) sweep(now);
    if (intents.size >= MAX) intents.delete(intents.keys().next().value);
    intents.set(key(guildId, userId), { intent: { ...intent }, at: now });
    return true;
}

/** The person's intent in that server, removed as it is read; null when none or too old. */
export function takeIntent(guildId, userId, now = Date.now()) {
    if (!guildId || !userId) return null;
    const k = key(guildId, userId);
    const v = intents.get(k);
    if (!v) return null;
    intents.delete(k);
    return now - v.at > TTL_MS ? null : v.intent;
}

export function _resetIntentsForTests() { intents.clear(); }
