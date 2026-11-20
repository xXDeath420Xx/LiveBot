// Screenshots for the giveaways-polls guide. Formats copied from: core/giveaway-manager.js (createGiveaway: the
// "🎉 GIVEAWAY 🎉" embed, primary colour, Ends field, "Hosted by" footer, the bot's own 🎉 reaction),
// core/polls-manager.js (renderPoll / formatPollOptions: number emoji, 10-block bars, "N votes" footer, ⏰ Ends field,
// a primary button per option), dashboard/routes/api/features/giveaways.js (host roles and panel the page loads).
export default async function ({ manage, discord, ctx, demo }) {
    const { channel, channels, member: M, role, D } = demo;
    const BOT = 'CertiFried Utility';
    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });

    // Poll: 17 votes over three options (10 / 5 / 2 → 59% / 29% / 12%).
    const bar = (pct) => '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    const opts = [['Yes', 10], ['No', 5], ['Saturday instead', 2]];
    const total = opts.reduce((n, [, c]) => n + c, 0);
    const nums = ['1️⃣', '2️⃣', '3️⃣'];
    const pollText = opts.map(([o, c], i) => { const p = Math.round((c / total) * 100); return `${nums[i]} **${o}**\n${bar(p)} ${p}% (${c} ${c === 1 ? 'vote' : 'votes'})`; }).join('\n\n');

    discord('giveaways-polls-discord', () => ({
        channel: channel.announcements.name, ctx: ctxNames,
        messages: [
            bot({
                time: 'Today at 6:00 PM',
                embeds: [{
                    color: '#5865F2', title: '🎉 GIVEAWAY 🎉',
                    description: 'Prize: **Maple Hollow hoodie**\nWinners: **1**\nReact with 🎉 to enter!',
                    fields: [{ name: 'Ends', value: 'in 3 days' }],
                    footer: `Hosted by ${M.juniper.displayName}`, timestamp: true,
                }],
                reactions: [{ emoji: '🎉', count: 24 }],
            }),
            bot({
                time: 'Today at 7:15 PM',
                embeds: [{
                    color: '#5865F2', title: '📊 Movie night on Friday?', description: pollText,
                    fields: [{ name: '⏰ Ends', value: 'Friday, 20 November 2026 18:00 (in 1 day)' }],
                    footer: `${total} votes`,
                }],
                buttons: opts.map(([o]) => ({ label: o, style: 'primary' })),
            }),
        ],
    }), { alt: 'A giveaway for a Maple Hollow hoodie with 24 party popper entries, ending in 3 days, then a poll on movie night with 17 votes: Yes 59 percent, No 29, Saturday instead 12.', guides: ['giveaways-polls'] });

    // The Giveaways page renders its list from locals and loads host roles and the panel after rendering.
    ctx.stub(/^\/api\/guilds\/\d+\/giveaways\/host-roles$/, () => ({ roles: [role.moderators.id] }));
    ctx.stub(/^\/api\/guilds\/\d+\/giveaways\/panel$/, () => ({ panel: { channel_id: channel.announcements.id, message_id: '100700000000000045' } }));
    manage('giveaways-polls-page', 'giveaways', {
        giveaways: [
            { id: 31, prize: 'Maple Hollow hoodie', channel_id: channel.announcements.id, ends_at: D(2026, 11, 22, 18), winner_count: 1, is_active: 1, winners: null },
            { id: 30, prize: 'Two copies of Stardew Valley', channel_id: channel.announcements.id, ends_at: D(2026, 11, 8, 18), winner_count: 2, is_active: 0, winners: JSON.stringify([M.wren.id, M.thistle.id]) },
            { id: 29, prize: 'Custom server emoji of your choice', channel_id: channel.general.id, ends_at: D(2026, 10, 25, 20), winner_count: 1, is_active: 0, winners: JSON.stringify([M.fennel.id]) },
        ],
    }, {
        alt: 'The Giveaways page: one running giveaway with End now and two ended ones with Reroll, each with Delete, under the Create giveaway button.',
        guides: ['giveaways-polls'], height: 900,
    });
}
