// Screenshots for the custom-bot guide. Formats copied from: dashboard/views/partials/manage/appearance.ejs
// (customBotInfo as the /manage loader in dashboard/server.js builds it). The bot, its id and its avatar are invented.
export default async function ({ manage, ctx, demo }) {
    const { member: M, D } = demo;
    const botAvatar = await ctx.file('custom-bot-avatar.png', () => ctx.artwork({ width: 256, height: 256, from: '#3f8f6b', to: '#8a7a2b', seed: 7 }));

    manage('custom-bot-setup', 'appearance', { settings: {}, customBotInfo: null }, {
        alt: 'The Custom bot section of Bot appearance: what to turn on in the Developer Portal, the Application ID and Bot token fields, and Set up custom bot.',
        guides: ['custom-bot'], scrollTo: '#custom-bot-setup',
    });

    manage('custom-bot-status', 'appearance', () => ({
        settings: { bot_nickname: 'Maple Helper' },
        customBotInfo: {
            bot_id: '100900000000000002', bot_name: 'Maple Helper', owner_user_id: M.juniper.id, owner_name: M.juniper.displayName,
            enabled: 1, approved: 1, self_service: 1, created_at: D(2026, 10, 3), assigned_at: D(2026, 10, 3),
            bot_avatar: botAvatar(), is_online: true,
        },
    }), {
        alt: 'The Custom bot panel for Maple Helper: online and active, set up by Juniper Vale as self-service, and the form to replace it with a different bot.',
        guides: ['custom-bot'], scrollTo: '#custom-bot-status',
    });
}
