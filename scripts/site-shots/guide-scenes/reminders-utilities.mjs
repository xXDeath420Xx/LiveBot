// Screenshots for the reminders-utilities guide. Formats copied from: core/reminder-manager.js sendReminder (a mention
// of the creator, then a #5865F2 "🔔 Reminder!" embed with the text and a "Set <date>" footer) and
// jobs/time-capsule-scheduler.js (#FFD700 "⏰ Time Capsule Revealed!", Created by / Created on fields). The page is
// dashboard/views/partials/manage/reminders.ejs with rows shaped like the reminders table the loader passes.
export default async function ({ manage, discord, ctx, demo }) {
    const { guild, channel, channels, member: M } = demo;
    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const origin = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: 'CertiFried Utility', avatarUrl: `${origin()}/images/CertiFried.png`, ...extra });

    discord('reminders-utilities-discord', () => ({
        channel: 'general', ctx: ctxNames,
        messages: [
            bot({
                time: 'Today at 7:30 PM', content: `<@${M.juniper.id}>`,
                embeds: [{ color: '#5865F2', title: '🔔 Reminder!', description: 'Movie night starts in the Campfire voice channel in 30 minutes. Grab a snack.',
                    footer: 'Set 11/13/2026, 7:30:00 PM', timestamp: true }],
            }),
            bot({
                time: 'Today at 8:00 PM',
                embeds: [{ color: '#FFD700', title: '⏰ Time Capsule Revealed!', timestamp: true,
                    description: 'Hello from October! If you are reading this, the winter event is over. Who won the snowball fight?',
                    fields: [{ name: 'Created by', value: `<@${M.sorrel.id}>`, inline: true }, { name: 'Created on', value: 'October 20, 2026', inline: true }] }],
            }),
        ],
    }), {
        alt: 'A reminder post mentioning Juniper Vale about movie night, then a time capsule from Sorrel Quinn opening a month after it was sealed.',
        guides: ['reminders-utilities'],
    });

    // remind_at is relative to when the shot is taken, so the "Due today" and "Next 7 days" counts stay sensible.
    const inH = (h) => new Date(Date.now() + h * 3600e3);
    const row = (id, message, at, channelId, userId, interval = null, count = null, sent = 0) => ({
        id, guild_id: guild.id, user_id: userId, channel_id: channelId, is_dm: 0, is_active: 1, message,
        remind_at: at, created_at: new Date(Date.now() - 7 * 86400e3), recurring_interval: interval, recurring_count: count, occurrences_sent: sent,
    });
    const reminders = [
        row(31, 'Movie night starts in the Campfire voice channel in 30 minutes. Grab a snack.', inH(5), channel.general.id, M.juniper.id, 604800, -1, 3),
        row(32, 'New art prompt is up. Share yours in the thread.', inH(29), channel.starboard.id, M.sorrel.id, 86400, 30, 12),
        row(33, 'Suggestion box closes tonight. Last call for ideas.', inH(52), channel.suggestions.id, M.hazel.id),
        row(34, 'Staff meeting in the Quiet Study voice channel.', inH(146), channel['mod-log'].id, M.rowan.id, 1209600, -1, 5),
    ];
    // The page names the "Created by" ids through GET /api/guilds/:id/users/resolve (public/js/cf-user.js).
    ctx.stub(/^\/api\/guilds\/\d+\/users\/resolve$/, () => ({
        users: Object.fromEntries(demo.members.map((m) => [m.id, { id: m.id, username: m.username, displayName: m.displayName, avatar: null, inServer: true }])),
    }));
    manage('reminders-utilities-page', 'reminders', { reminders }, {
        alt: 'The Reminders page: four upcoming channel reminders with when each is sent, how it repeats, its channel, who made it and a Delete button.',
        guides: ['reminders-utilities'], scrollTo: '#rm-list-title',
    });
}
