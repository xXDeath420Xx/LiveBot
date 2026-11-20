// Screenshots for the nsfw-protection guide. The page (dashboard/views/partials/manage/nsfw-protection.ejs) loads
// its data from /api/guilds/:id/nsfw-protection (dashboard/routes/api/features/nsfw-protection.js, core/nsfw-protection.js
// overview()); the stubs below answer with the same shape, Maple Hollow numbers.
export default async function ({ manage, ctx, demo }) {
    const yes = { ban: true, kick: true, flag: true, delete: true, timeout: true };
    const day = (n) => new Date(Date.UTC(2026, 10, 19 - n)).toISOString().slice(0, 10);
    const days = Array.from({ length: 7 }, (_, i) => ({
        date: day(6 - i), nsfw_avatar_scans: [14, 9, 22, 11, 17, 8, 12][i], nsfw_image_scans: [130, 96, 151, 118, 142, 87, 64][i],
        nsfw_avatar_hits: i === 2 ? 1 : 0, nsfw_image_hits: i === 4 ? 1 : 0, nsfw_avatar_skipped: 0, nsfw_image_skipped: 0,
    }));
    ctx.stub(/^\/api\/guilds\/\d+\/nsfw-protection\/?$/, () => ({
        actor: { canConfigure: true, perms: yes, superAdmin: false },
        botPerms: yes,
        model: {
            installed: true, partial: false, missing: [],
            models: [{ id: 'marqo-nsfw-384', ok: true }, { id: 'falconsai-nsfw-vit-int8', ok: true }],
            workers: { running: 1, max: 2, threadsEach: 2 }, queue: { priority: 0, normal: 0, dropped: 0, expired: 0 },
            completed: 412, avgMs: 210, failed: 0, paused: null, lastError: null,
        },
        models: [
            { id: 'marqo-nsfw-384', name: 'Marqo NSFW image detection 384 (ViT-tiny)', licence: 'Apache-2.0' },
            { id: 'falconsai-nsfw-vit-int8', name: 'Falconsai NSFW image detection (ViT-base, int8)', licence: 'Apache-2.0' },
        ],
        avatar: { enabled: true, action: 'log', act: 0.9, review: 0.6, dailyCap: 1000, dm: true },
        image: { enabled: true, action: 'alert', timeoutMinutes: 60, act: 0.9, review: 0.6, reviewAlerts: false, dailyCap: 2000 },
        actions: { avatar: ['log', 'flag', 'kick', 'ban'], image: ['alert', 'delete', 'timeout'] },
        counts: { avatar: { pending: 1, actioned: 0 }, image: { pending: 0, actioned: 1 } },
        cap: { avatar: { used: 12, limit: 1000, allowed: true }, image: { used: 64, limit: 2000, allowed: true } },
        usage: {
            today: { sinceRestart: { avatar: { nsfw: 0, capped: 0, dropped: 0 }, image: { nsfw: 1, capped: 0, dropped: 0 } } },
            days,
        },
        scan: null,
    }));
    ctx.stub(/^\/api\/guilds\/\d+\/nsfw-protection\/reviews$/, () => ({ rows: [], counts: { avatar: { pending: 1, actioned: 0 }, image: { pending: 0, actioned: 1 } } }));
    ctx.stub(/^\/api\/guilds\/\d+\/nsfw-protection\/recent$/, () => ({ recent: [] }));
    ctx.stub(/^\/api\/guilds\/\d+\/nsfw-protection\/safe$/, () => ({ safe: [] }));
    ctx.stub(/^\/api\/guilds\/\d+\/nsfw-protection\/scan$/, () => ({ running: false }));

    manage('nsfw-protection-page', 'nsfw-protection', {}, {
        alt: 'The NSFW protection page: both models loaded, and avatar checks switched on with Log only and review and an act threshold of 0.90.',
        guides: ['nsfw-protection'], scrollTo: '#npModelCard',
    });
}
