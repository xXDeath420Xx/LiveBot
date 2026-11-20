// Screenshots for the twitch-tools guide. Formats copied from: jobs/twitch-clip-checker.js (clipEmbed: colour, title, Playing,
// Length and Views fields, "Clipped by" footer, timestamp). The auto-track page renders dashboard/views/partials/manage/streaming.ejs.
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, channel, role, roles, member: M, streamers: S } = demo;
    const supportersLive = { id: '100400000000000092', name: 'supporters-live', type: 0, parentId: null };
    const allChannels = [...channels, supportersLive];

    manage('twitch-tools-auto-track', 'auto-track', {
        channels: allChannels,
        consolidatedStreamers: [], teamSubscriptions: [], twitchScheduleSyncs: [], scheduleTemplates: [], streamEndedSubs: [],
        settings: { default_edit_on_end: 1, default_delete_on_end: 0 },
        liveRoutingRules: [{
            rule_id: 1, label: 'Supporters', priority: 10, channel_id: supportersLive.id, role_ids: [role.supporters.id],
            source_channel_ids: [], excluded_user_ids: [], exclude_owner: 1, apply_to_unrouted: 0, enabled: 1,
        }],
        autoTrackConfigs: [{
            auto_id: 1, role_id: role.regulars.id, announcement_channel_id: channel['stream-alerts'].id, live_role_id: role.live.id,
            enabled: 1, delete_on_end: 0, edit_on_end: 1, min_level: 0,
        }],
    }, {
        alt: 'Auto-track mappings: one mapping that announces Regulars who go live on Twitch in #stream-alerts with the Live now role, and the form for adding another.',
        guides: ['twitch-tools'], scrollTo: '[aria-labelledby="st-at-title"]',
    });

    const thumb = await ctx.file('twitch-tools-clip.png', () => ctx.artwork({ from: '#2f7fa8', to: '#6aa84f', caption: 'The greenhouse door, again' }));
    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    discord('twitch-tools-clip', () => ({
        channel: 'stream-alerts',
        ctx: { channels: allChannels.map((c) => ({ id: c.id, name: c.name })), roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })) },
        messages: [{
            username: BOT, avatarUrl: `${B()}/images/CertiFried.png`,
            embeds: [{
                color: '#9146FF', title: 'The greenhouse door closes on its own (again)', url: 'https://example.invalid/',
                fields: [{ name: 'Playing', value: S.rowan.game, inline: true }, { name: 'Length', value: '28s', inline: true }, { name: 'Views', value: '143', inline: true }],
                image: thumb(), footer: `Clipped by ${M.pip.username}`, timestamp: true,
            }],
        }],
    }), {
        alt: 'A new clip posted in #stream-alerts: its title, the game, a length of 28 seconds, 143 views and who made the clip.',
        guides: ['twitch-tools'],
    });
}
