// Screenshots for the voice-channels guide. The Utilities page renders dashboard/views/partials/manage/utilities.ejs with a
// temp_channel_config row (creator channel, category, naming template). The Join to create channel is invented.
export default async function ({ manage, demo }) {
    const joinToCreate = { id: '100500000000000091', name: 'Join to create', type: 2 };
    const community = demo.categories.find((c) => c.name === 'Community');
    manage('voice-channels-page', 'utilities', {
        voiceChannels: [joinToCreate, ...demo.voiceChannels],
        autoPublisherConfig: {}, autorolesConfig: {},
        tempChannelConfig: { guild_id: demo.guild.id, creator_channel_id: joinToCreate.id, category_id: community.id, naming_template: "{username}'s Channel" },
    }, {
        alt: 'Temporary voice channels on the Utilities page: switched on, with Join to create as the creator channel, the Community category and the name {username}\'s Channel.',
        guides: ['voice-channels'], scrollTo: '[aria-labelledby="ut-temp-title"]',
    });
}
