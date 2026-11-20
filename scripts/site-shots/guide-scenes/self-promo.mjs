// Screenshots for the self-promo guide. Page: dashboard/views/partials/manage/self-promo.ejs, with the locals the
// /manage route passes (selfPromoConfig, channels, roles).
export default async function ({ manage, demo }) {
    const { channels } = demo;
    // An invented request channel (fake id).
    const promo = { id: '100400000000000092', name: 'self-promo', type: 0, parentId: null };

    manage('self-promo-page', 'self-promo', {
        channels: [...channels, promo],
        selfPromoConfig: {
            enabled: 1, channel_id: promo.id, announcement_channel_id: null, same_channel: 1,
            allowed_platforms: ['twitch', 'kick', 'youtube'], auto_subscribe: 1, keep_message: 1, delete_invalid: 0,
            dm_on_track: 1, dm_on_already_tracked: 1, announce_gate_enabled: 0, announce_min_level: 1,
            announce_required_role_ids: [], announce_delete_unauthorized: 1,
        },
    }, { alt: 'The Self-promo page: switched on, #self-promo as the request channel, go-lives announced there, and Twitch, Kick and YouTube links accepted.', guides: ['self-promo'] });
}
