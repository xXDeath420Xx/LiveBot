/*
 * Stream bot, YouTube: no rewards for YouTube engagement (Google OAuth verification, 2026-11-21). Pure.
 *
 * YouTube API Services Developer Policies III.F.3.c: an API client must not offer incentives, rewards or other compensation
 * for engaging with YouTube (Google's example: rewarding people for subscribing or liking). So on YouTube:
 *   - nobody earns points: no follow (new subscriber), membership, gift or watch-time points, no automation "Give points"
 *     or "Set points", no !addpoints, !give or imported points steps;
 *   - nothing that spends points is offered: the loyalty store, raffles, points games and media share are Twitch and Kick only;
 *   - alerts, thank-you messages, counts on the viewer record and ranks by watch time stay: they recognise, they do not pay.
 *
 *   noRewards(platform)              true for YouTube
 *   POINTS_PLATFORMS                 where points can be earned and spent
 *   isYouTubeRow(row)                a viewer record of a YouTube account
 *   youtubeOnlyTrigger(type, cfg)    an automation trigger that can only fire from YouTube
 *   dropRewardSteps(actions)         the steps without points.add / points.set (nested "pick one at random" branches too)
 *   YT_POINTS_REPLY                  what YouTube chat is told when someone types a points command there
 *   YT_POINTS_NOTE                   the line the dashboard shows next to points features
 *
 * Tested in tests/youtube-no-rewards.test.js.
 */

export const POINTS_PLATFORMS = Object.freeze(['twitch', 'kick']);
export const REWARD_STEPS = Object.freeze(['points.add', 'points.set']);

export const noRewards = (platform) => platform === 'youtube';
export const isYouTubeRow = (row) => !!row && row.platform === 'youtube';

export const YT_POINTS_REPLY = 'Points, the store, raffles and points games are on Twitch and Kick only. YouTube does not allow rewards for subscribing, joining or chatting.';
export const YT_POINTS_NOTE = 'YouTube viewers do not earn or spend points. YouTube\'s API rules do not allow rewards for subscribing, joining or chatting, so points, the store, raffles, points games and media share are for Twitch and Kick.';

/** Event types whose only viewer platform is YouTube (the others that raise them are tip services, which have no viewers). */
const YOUTUBE_VIEWER_TYPES = new Set(['membership']);

/** True when an automation trigger can only reach a viewer through YouTube. */
export function youtubeOnlyTrigger(type, cfg = {}) {
    const p = Array.isArray(cfg?.platforms) ? cfg.platforms.filter(Boolean) : [];
    if (p.length && p.every((x) => x === 'youtube')) return true;
    return YOUTUBE_VIEWER_TYPES.has(type) && (!p.length || p.includes('youtube'));
}

/** Steps without the ones that give points; `removed` counts what was taken out. */
export function dropRewardSteps(actions = []) {
    let removed = 0;
    const walk = (list) => (Array.isArray(list) ? list : []).flatMap((s) => {
        if (!s || typeof s !== 'object') return [s];
        if (REWARD_STEPS.includes(s.type)) { removed++; return []; }
        if (s.type === 'random' && Array.isArray(s.branches)) return [{ ...s, branches: s.branches.map((b) => ({ ...b, actions: walk(b.actions) })) }];
        return [s];
    });
    const out = walk(actions);
    return { actions: out, removed };
}

export default { POINTS_PLATFORMS, REWARD_STEPS, noRewards, isYouTubeRow, youtubeOnlyTrigger, dropRewardSteps, YT_POINTS_REPLY, YT_POINTS_NOTE };
