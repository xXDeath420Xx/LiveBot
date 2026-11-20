// Screenshots for the stream-alert-options guide. The Live alert style page renders dashboard/views/partials/manage/streaming.ejs
// (appearance tab) and live-style.ejs; its rows come from GET /api/guilds/:id/live-style (dashboard/routes/api/features/live-style.js),
// answered here with the labels of core/stream-render-style.js.
export default async function ({ manage, ctx, demo }) {
    const { channel, role, streamers: S } = demo;
    const STYLES = [
        { value: 'twitch', label: 'Platform preview (Twitch-style thumbnail)' },
        { value: 'card', label: 'Custom rendered card' },
        { value: 'v2', label: 'Components V2 (new Discord layout — container, media gallery, watch button)' },
    ];
    ctx.stub(/^\/api\/guilds\/\d+\/live-style$/, () => ({
        defaultStyle: 'twitch', styles: STYLES,
        current: { guild: 'card', channels: {}, streamers: {} },
        channels: [
            { channel_id: channel['stream-alerts'].id, name: 'stream-alerts', streamer_count: 3, style: null },
            { channel_id: channel['new-videos'].id, name: 'new-videos', streamer_count: 1, style: 'v2' },
        ],
        streamers: [
            { streamer_id: '21', username: S.bramble.name, platform: 'kick', subscription_count: 1, style: 'twitch' },
            { streamer_id: '22', username: 'hazelmarsh_tv', platform: 'twitch', subscription_count: 1, style: null },
            { streamer_id: '23', username: S.rowan.name, platform: 'twitch', subscription_count: 1, style: null },
            { streamer_id: '24', username: S.sorrel.name, platform: 'youtube', subscription_count: 1, style: null },
        ],
    }));

    manage('stream-alert-options-style', 'announcements', {
        consolidatedStreamers: [], teamSubscriptions: [], twitchScheduleSyncs: [], scheduleTemplates: [], autoTrackConfigs: [], streamEndedSubs: [],
        settings: { announcement_channel_id: channel['stream-alerts'].id, live_role_id: role.live.id, default_edit_on_end: 1, default_delete_on_end: 0 },
    }, {
        alt: 'Live announcement style: the server default set to the custom card, #new-videos set to Components V2, and one streamer kept on the platform preview.',
        guides: ['stream-alert-options'], scrollTo: '#liveStyleCard',
    });
}
