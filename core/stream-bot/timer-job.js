/*
 * The minute job behind every timer (jobs/kick-timer-scheduler.js calls runDueTimers once a minute).
 *
 * Kick channel page timers post on their Kick channel through the Kick Defender sign-in, as they always did.
 * Stream bot timers post on the profile's linked channels: Twitch through the CertiFried bot account (the chat
 * action's path, io.sendChat), Kick through the same Kick path, YouTube as the streamer's channel through io.sendChat
 * (20 quota units a post; only for timers set to YouTube, only while YouTube is set up, and not once the quota guard
 * is at 'critical'; timers.js timerTargets). A timer that runs an automation starts it with the
 * engine's manual option (no trigger match or conditions; the profile's busy limits still apply), source 'timer'.
 * last_sent_at only moves when something was posted or run, so a timer held back by "only while live" or
 * "N chat lines" is checked again the next minute.
 *
 * If migration 456 has not been applied yet, the job falls back to the old Kick-only query and plain sending.
 */
import { createTimerStore, fireTimer, legacyTokens, renderPlain, timerTargets } from './timers.js';
import { youtubeBotConfig } from './youtube/config.js';

let warnedSchema = false;

function timerEvent(t, target, type) {
    return {
        platform: target.platform, type: type || 'chat', channelId: target.channelId, user: null, amount: null, currency: null, message: null,
        metadata: { via: 'timer', timerId: Number(t.id), timer: t.name || null }, raw: null, occurredAt: new Date(), dedupeKey: null,
    };
}

async function legacyRun({ pool, logger, sendKick }) {
    const [rows] = await pool.query(`
        SELECT t.id, t.message, c.channel_id AS kick_channel_id, c.channel_name
        FROM tokes_timers t JOIN tokes_channels c ON c.id = t.channel_id
        WHERE t.is_enabled = 1 AND c.platform = 'kick' AND c.is_enabled = 1 AND c.defender_enabled = 1
          AND (t.last_sent_at IS NULL OR t.last_sent_at <= (NOW() - INTERVAL t.interval_min MINUTE))`);
    let sent = 0;
    for (const t of rows) {
        const text = String(t.message || '').replace(/\{\{channel_name\}\}/g, () => t.channel_name || '');
        if (await sendKick(t.kick_channel_id, text).catch(() => false)) {
            await pool.query('UPDATE tokes_timers SET last_sent_at = NOW(), send_count = send_count + 1 WHERE id = ?', [t.id]);
            sent++;
        } else logger?.warn?.('[KickTimers] Send failed', { timerId: t.id, channel: t.channel_name });
    }
    return { due: rows.length, sent };
}

/** @returns {Promise<{ due, sent }>} */
export async function runDueTimers({ pool, logger = null, sendKick, getStreamBot = null } = {}) {
    const store = createTimerStore({ db: pool });
    let rows;
    try {
        rows = await store.due();
    } catch (err) {
        if (err?.code === 'ER_BAD_FIELD_ERROR') {
            if (!warnedSchema) { warnedSchema = true; logger?.warn?.('[KickTimers] migration 456 not applied yet; running Kick page timers the old way'); }
            return legacyRun({ pool, logger, sendKick });
        }
        throw err;
    }
    if (!rows.length) return { due: 0, sent: 0 };
    let sb = null;
    try { sb = await (getStreamBot || (await import('./index.js')).getStreamBot)(); } catch (err) { logger?.warn?.('[KickTimers] stream bot unavailable', { error: err?.message }); }

    let sent = 0;
    for (const t of rows) {
        try {
            let profile = null;
            let targets = [];
            if (t.profile_id != null) {
                if (!sb) continue;
                profile = await sb.store.getProfile(Number(t.profile_id));
                if (!profile?.enabled) continue;
                const channels = await sb.io.channelsFor(profile.id);
                let youtubeLevel = 'normal';
                try { youtubeLevel = sb.youtube?.quota?.level?.() || 'normal'; } catch { /* no guard: YouTube is off */ }
                targets = timerTargets(t.platforms, channels, { youtube: youtubeBotConfig().enabled && !!sb.youtube?.service, youtubeLevel })
                    // A YouTube chat exists only during a broadcast: skip YouTube while it is not live (the service's own state, no API call).
                    .filter((tg) => tg.platform !== 'youtube' || !!sb.youtube.service.streamInfo?.({ profileId: profile.id, channelId: tg.channelId })?.live);
            } else {
                targets = [{ platform: 'kick', channelId: String(t.kick_channel_id), login: t.channel_name || '' }];
            }
            const info = (platform, channelId) => (sb ? sb.streamInfo.get({ profileId: profile?.id ?? null, platform, channelId }) : Promise.resolve(null));
            const r = await fireTimer(t, {
                targets,
                streamInfo: info,
                async render(text, target, known) {
                    if (profile && sb) {
                        return sb.render(legacyTokens(text), {
                            ev: timerEvent(t, target), profileId: profile.id, automationId: 0, channelName: target.login,
                            stream: async () => known || info(target.platform, target.channelId),
                        });
                    }
                    const wantsInfo = /\{stream\./i.test(text);
                    return renderPlain(text, { channelName: target.login, info: known || (wantsInfo ? await info(target.platform, target.channelId) : null) });
                },
                async send({ platform, channelId, login, text }) {
                    if (platform === 'kick') {
                        sb?.ingest?.noteSent('kick', channelId, text);
                        return !!(await sendKick(channelId, text));
                    }
                    if (!sb) return false;
                    const res = await sb.io.sendChat({ profileId: profile?.id, platform: platform === 'youtube' ? 'youtube' : 'twitch', channelId, login, text });
                    // Not live on YouTube is not a failure: the timer is checked again next minute (no YouTube call was made).
                    if (!res.ok && !res.notLive) logger?.warn?.(`[KickTimers] ${platform === 'youtube' ? 'YouTube' : 'Twitch'} send failed`, { timerId: t.id, error: res.error });
                    return !!res.ok;
                },
                async runAutomation(target) {
                    const a = await sb.store.getAutomation(profile.id, Number(t.automation_id));
                    if (!a) return { status: 'failed' };
                    if (!a.enabled) return { status: 'skipped' };
                    sb.engine.runAutomation(profile, a, timerEvent(t, target, a.trigger_type), { source: 'timer', manual: true })
                        .catch((err) => logger?.warn?.('[KickTimers] automation run failed', { timerId: t.id, error: err?.message }));
                    return { status: 'running' };
                },
            });
            if (r.sent) {
                await store.markSent(t.id, r.nextIndex);
                sent++;
            } else if (/not sent|empty/.test(r.detail || '')) {
                logger?.warn?.('[KickTimers] Timer not sent', { timerId: t.id, detail: r.detail });
            }
        } catch (err) {
            logger?.warn?.('[KickTimers] Timer error', { timerId: t.id, error: err?.message });
        }
    }
    return { due: rows.length, sent };
}

export default { runDueTimers };
