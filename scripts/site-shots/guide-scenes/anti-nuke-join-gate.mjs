// Screenshots for the anti-nuke-join-gate guide. Formats copied from: core/anti-nuke-manager.js (_sendAlert),
// dashboard/views/partials/manage/security.ejs (the page; its spammer-scan and score calls are stubbed).
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, channel, role, member: M } = demo;
    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);   // the local server's origin, once it runs
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });
    const names = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };

    // The anti-nuke alert: a moderator account deleting channels (an invented incident).
    discord('anti-nuke-join-gate-alert', () => ({
        channel: 'mod-log', ctx: names,
        messages: [bot({
            embeds: [{
                color: '#ED4245', title: '🗑️ Anti-Nuke Triggered',
                description: `**${M.fennel.username}** (${M.fennel.id}) triggered anti-nuke protection!`,
                fields: [
                    { name: 'Action Type', value: 'channel deletion', inline: true },
                    { name: 'Count', value: '3', inline: true },
                    { name: 'Response', value: 'Kicked from server', inline: true },
                ],
                thumbnail: ctx.av('fennel'), footer: 'Anti-Nuke Protection System', timestamp: true,
            }],
        })],
    }), { alt: 'An Anti-Nuke Triggered alert in #mod-log: fennelfox_ deleted 3 channels, and the response was a kick from the server.', guides: ['anti-nuke-join-gate'] });

    // The Join gate and anti-nuke page, scrolled to the account age gate.
    const joinGateConfig = {
        enabled: true, role_id: role.verified.id, verify_mode: 'captcha',
        age_gate_enabled: 1, kick_under_hours: 24, apply_under_days: 7, min_account_age_days: 1, action: 'kick', block_default_avatar: 1,
        review_channel_id: channel['mod-log'].id, invite_channel_id: channel.welcome.id, log_channel_id: channel['mod-log'].id,
        rejoin_limit_enabled: 1, rejoin_max_joins: 3, rejoin_window_days: 0, rejoin_action: 'ban',
        spammer_enabled: 1, spammer_action: 'kick', spammer_silent: 0,
    };
    ctx.stub(/^\/api\/guilds\/\d+\/spammer-scan\/activity$/, () => ({ last30: { spammer_kicked: 4 }, events: [] }));
    ctx.stub(/^\/api\/guilds\/\d+\/spammer-scan\/allowlist$/, () => ({ users: [] }));
    ctx.stub(/^\/api\/guilds\/\d+\/insight\/score$/, () => ({ score: { level: 'Good', percent: 83, on: 5, total: 6 } }));
    manage('anti-nuke-join-gate-page', 'security', {
        antiNukeConfig: { enabled: 1, alert_channel_id: channel['mod-log'].id, max_channel_deletes: 3, max_role_deletes: 3, max_kick_bans: 3, action_on_trigger: 'kick' },
        antiRaidConfig: { enabled: true, auto_lockdown: true, threshold: 20, time_period: 10, duration_minutes: 60, action: 'kick', raid_detection: true, same_name: true },
        joinGateConfig,
    }, {
        alt: 'The Account age gate on the dashboard: accounts under 24 hours are removed, under 7 days they must apply, applications go to #mod-log.',
        guides: ['anti-nuke-join-gate'], scrollTo: 'section[aria-labelledby="sec-age-title"]',
    });
}
