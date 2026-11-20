// Screenshots for the server-stats guide. Formats copied from: dashboard/views/partials/manage/serverstats.ejs
// and dashboard/routes/features/statistics.js (GET /manage/:id/serverstats), dashboard/views/partials/manage/
// stat-displays.ejs (statDisplayChannels rows as dashboard/server.js loads them from stat_display_channels).
export default async function ({ manage, ctx, demo }) {
    const { guild, role, roles, channel, voiceChannels, member: M } = demo;

    // ── Server stats: the page loads everything from /manage/:id/serverstats ──
    const DAY = 86400000;
    const perDay = [412, 388, 530, 611, 498, 702, 655, 590];
    const heat = [];
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
        const evening = h >= 17 && h <= 23 ? 3 : h >= 12 ? 2 : h >= 8 ? 1 : 0;
        const weekend = d === 0 || d === 6 ? 1.4 : 1;
        heat.push({ day_of_week: d, hour_of_day: h, message_count: Math.round((evening * 40 + ((d * 7 + h * 3) % 11)) * weekend) });
    }
    ctx.stub(/^\/manage\/\d+\/serverstats$/, () => ({
        period: '7d', days: 7,
        currentStats: { total_messages: 3974, active_members: 186, members_joined: 41, members_left: 12, voice_minutes: 5220, commands_used: 318 },
        prevStats: { total_messages: 3410, active_members: 171, members_joined: 33, members_left: 15, voice_minutes: 4980, commands_used: 290 },
        // The page lays the bars out from the browser's today, so the days count back from the moment of the shot.
        dailyMessages: perDay.map((n, i) => ({ date: new Date(Date.now() - (7 - i) * DAY).toISOString(), messages: n })),
        topMessagers: [M.pip, M.wren, M.thistle, M.hazel, M.fennel].map((m, i) => ({ user_id: m.id, username: m.username, total_messages: [412, 377, 301, 264, 198][i] })),
        channelActivity: [['general', 1810], ['bot-commands', 602], ['music-requests', 455], ['suggestions', 233], ['level-ups', 140]].map(([n, c]) => ({ channel_id: channel[n].id, channel_name: n, total_messages: c })),
        peakHours: heat,
        topEmojis: [['🌰', 214], ['🍂', 160], ['😂', 133], ['❤️', 98], ['🎃', 71]].map(([e, n]) => ({ emoji_id: e, emoji_name: e, is_custom: 0, use_count: n })),
    }));
    manage('server-stats-page', 'serverstats', { guild }, {
        alt: 'The Server stats page for the last 7 days: 3,974 messages, 186 members who posted, 41 joined and 12 left, with messages per day and the top senders and channels.',
        guides: ['server-stats'], height: 900, scrollTo: '#stats-overview',
    });

    // ── Stat display channels: four displays and the add form ──
    const vc = (n, name) => ({ id: `1005000000000000${String(90 + n)}`, name, type: 2 });
    const shown = [vc(1, 'Members: 1,284'), vc(2, '🕐 | 7:40pm'), vc(3, '312 Verified'), vc(4, 'Followers: 2,418')];
    const rows = [
        { id: 1, channel_id: shown[0].id, stat_type: 'members', template: 'Members: {value}', config: null },
        { id: 2, channel_id: shown[1].id, stat_type: 'time', template: '🕐 | {value}', config: null },
        { id: 3, channel_id: shown[2].id, stat_type: 'role', template: '{value} Verified', config: JSON.stringify({ role_id: role.verified.id }), role_name: role.verified.name },
        { id: 4, channel_id: shown[3].id, stat_type: 'twitch_followers', template: 'Followers: {value}', config: JSON.stringify({ twitch_username: demo.streamers.rowan.name }) },
    ];
    manage('server-stats-displays', 'stat-displays', { guild, roles, voiceChannels: [...shown, ...voiceChannels], statDisplayChannels: rows }, {
        alt: 'The Stat display channels page: total members, the local time, members with the Verified role and Twitch followers, each shown in a voice channel name, and the form to add another.',
        guides: ['server-stats'], height: 900, scrollTo: '#sd-list-title',
    });
}
