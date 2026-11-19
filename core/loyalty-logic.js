/*
 * Loyalty point rules — pure, dependency-free (tests/bgames-logic.test.js).
 *
 * Points are earned from activity the bot already records, once per day per member, by the
 * scheduler (core/loyalty-manager.js):
 *   - message_stats  (per user, per channel, per day — written for every message)
 *   - voice_activity (one row per finished voice session)
 * No new hot-path hook is needed.
 */

export const LOYALTY_DEFAULTS = Object.freeze({
    enabled: false,
    daily_active_points: 10,
    min_daily_messages: 3,
    min_voice_minutes: 15,
    voice_minutes_per_point: 10,
    max_voice_points_per_day: 30,
    streak_bonus_per_day: 2,
    max_streak_bonus: 20,
    redemption_log_channel_id: null,
    points_name: 'loyalty points',
});

/** 'YYYY-MM-DD' of the day before, computed in UTC so no local timezone can shift it. */
export function dayBefore(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const t = Date.UTC(y, m - 1, d) - 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
}

const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
};

/**
 * Points for one member for one day.
 *
 * @param {{messages:number, voiceMinutes:number, date:string, lastActiveDate:string|null, currentStreak:number}} day
 * @param {object} settings  LOYALTY_DEFAULTS-shaped
 * @returns {{active:boolean, points:number, streak:number, parts:{daily:number, voice:number, streak:number}}}
 */
export function computeDailyAward(day, settings = LOYALTY_DEFAULTS) {
    const s = { ...LOYALTY_DEFAULTS, ...settings };
    const messages = Math.max(0, num(day.messages, 0));
    const voiceMinutes = Math.max(0, num(day.voiceMinutes, 0));
    const active = messages >= num(s.min_daily_messages, 3) || voiceMinutes >= num(s.min_voice_minutes, 15);

    const perPoint = num(s.voice_minutes_per_point, 10);
    const voice = perPoint > 0
        ? Math.min(Math.max(0, num(s.max_voice_points_per_day, 30)), Math.floor(voiceMinutes / perPoint))
        : 0;

    let streak = Math.max(0, num(day.currentStreak, 0));
    let streakBonus = 0;
    let daily = 0;
    if (active) {
        streak = day.lastActiveDate && day.lastActiveDate === dayBefore(day.date) ? streak + 1 : 1;
        daily = Math.max(0, num(s.daily_active_points, 10));
        streakBonus = Math.min(Math.max(0, num(s.max_streak_bonus, 20)), (streak - 1) * Math.max(0, num(s.streak_bonus_per_day, 2)));
    }
    return { active, points: daily + voice + streakBonus, streak, parts: { daily, voice, streak: streakBonus } };
}

/** The streak to SHOW today: a streak is only alive if the member was active yesterday or today. */
export function liveStreak(currentStreak, lastActiveDate, todayStr) {
    if (!lastActiveDate || !currentStreak) return 0;
    if (lastActiveDate === todayStr || lastActiveDate === dayBefore(todayStr)) return currentStreak;
    return 0;
}

export const REWARD_TYPES = Object.freeze({
    role: 'Role',
    coins: 'Coins',
    xp: 'XP',
    custom: 'Custom (staff fulfil)',
});
