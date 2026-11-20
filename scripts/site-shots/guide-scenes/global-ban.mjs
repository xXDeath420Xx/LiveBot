// Screenshots for the global-ban guide. Formats copied from: core/global-ban-manager.js (sendAlert),
// core/global-ban-confidence.js (decideEnforcement "why" text), dashboard/views/partials/manage/global-ban.ejs
// (the page; its network, list and action-log calls are stubbed).
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, channel, member: M } = demo;
    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);   // the local server's origin, once it runs
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });
    const names = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };

    // The page: protection on, Protect mode at 75, alerts to #mod-log, the default actions.
    const day = (n) => new Date(Date.UTC(2026, 10, 19 - n, 15, 30)).toISOString();
    ctx.stub(/^\/api\/guilds\/\d+\/global-ban\/network$/, () => ({
        stats: {
            activeEntries: 1843, participatingServers: 61, addedThisWeek: 37, automaticEntries: 1290,
            enabledByMode: { protect: 48, alert: 9, feed: 4 }, trackedUsers: 5210, contributingServers: 74, signalsThisWeek: 412,
            mine: { actions30d: 6, alerts30d: 3, contributed90d: 11 },
            recent: [{ user_id: M.spam.id, username: M.spam.username, severity: 'high', category: 'phishing', source: 'auto_aggregate', confidence: 88, created_at: day(1) }],
        },
    }));
    ctx.stub(/^\/api\/guilds\/\d+\/global-ban\/entries$/, () => ({
        success: true,
        entries: [{ user_id: M.spam.id, username: M.spam.username, severity: 'high', category: 'phishing', source: 'auto_aggregate', reason: 'Auto-aggregated: confidence 88 from 3 independent servers', evidence: null, created_at: day(1) }],
        pagination: { page: 1, limit: 20, total: 1, pages: 1 },
    }));
    ctx.stub(/^\/api\/guilds\/\d+\/global-ban\/action-log$/, () => ({ success: true, logs: [], pagination: { page: 1, limit: 15, total: 0, pages: 0 } }));
    manage('global-ban-page', 'global-ban', {
        globalBanConfig: {
            enabled: 1, mode: 'protect', confidence_threshold: 75, alert_channel_id: channel['mod-log'].id,
            check_on_join: 1, check_on_message: 0, auto_aggregate_opt_in: 1, exempt_roles: [],
            action_critical: 'ban', action_high: 'ban', action_medium: 'kick', action_low: 'alert',
        },
    }, {
        alt: 'The Global ban page: Protect mode selected, a confidence of 75 needed to act, alerts going to #mod-log, and this server\'s bans contributed.',
        guides: ['global-ban'], scrollTo: 'section[aria-labelledby="gb-protect-title"]',
    });

    // A network hit on join in Protect mode (an invented account).
    discord('global-ban-alert', () => ({
        channel: 'mod-log', ctx: names,
        messages: [bot({
            embeds: [{
                color: '#E74C3C', title: 'Global Ban Alert',
                description: 'A user with an active global ban record has been detected.',
                fields: [
                    { name: 'User', value: `${M.spam.username} (<@${M.spam.id}>)`, inline: true },
                    { name: 'Severity', value: 'HIGH', inline: true },
                    { name: 'Category', value: 'phishing', inline: true },
                    { name: 'Confidence', value: '88/100', inline: true },
                    { name: 'Action Taken', value: 'Banned', inline: true },
                    { name: 'Entry ID', value: '#412', inline: true },
                    { name: 'Why', value: 'protect mode: confidence 88 is at or above 75' },
                ],
                footer: `User ID: ${M.spam.id}`, timestamp: true,
            }],
            buttons: [{ label: 'View Full Record', style: 'primary' }, { label: 'Dismiss', style: 'secondary' }],
        })],
    }), { alt: 'A Global Ban Alert in #mod-log: a high-severity phishing account with a confidence of 88 out of 100 was banned on joining.', guides: ['global-ban'] });
}
