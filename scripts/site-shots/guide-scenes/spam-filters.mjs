// Screenshots for the spam-filters guide. Formats copied from: core/selfbot-detection-manager.js (sendAlert embed
// and buttons), dashboard/views/partials/manage/advanced-protection.ejs. The page's raid-lockdown panel uses the
// /raid-lockdown stub scenes.mjs already registers.
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, channel, member: M, D } = demo;

    manage('spam-filters-page', 'advanced-protection', {
        raidConfig: { enabled: 1, join_threshold: 10, join_timeframe_seconds: 10, new_account_age_hours: 72, new_account_ratio: 0.5, action: 'mute', mute_duration_minutes: 60, purge_messages: 0, alert_channel_id: channel['mod-log'].id },
        selfbotConfig: { enabled: 1, action: 'alert', alert_channel_id: channel['mod-log'].id, message_burst_threshold: 20, message_burst_window_ms: 1000, min_response_time_ms: 50, pattern_threshold: 3 },
        adaptiveSpamConfig: { enabled: 1, action: 'alert', alert_channel_id: channel['mod-log'].id, cross_channel_threshold: 3, cross_channel_timeframe_minutes: 5, deviation_multiplier: 2.0, new_account_multiplier_7d: 1.5, new_account_multiplier_24h: 2.0, exempt_channels: '[]' },
        inviteFilterConfig: { enabled: 1, action: 'delete_warn', log_channel_id: channel['mod-log'].id, use_whitelist: 0 },
        inviteFilterEntries: { users: [], roles: [], channels: [], invites: [] },
        raidIncidents: [],
        selfbotDetections: [
            { detected_at: D(2026, 11, 17, 22, 4), user_id: M.spam.id, detection_type: 'message_burst', confidence_score: 70, action_taken: 'alert' },
        ],
    }, { alt: 'The Self-bot detection settings on the Raid lockdown page: switched on, what it looks for, and the response time, burst and strike limits.', guides: ['spam-filters'], scrollTo: '[aria-labelledby="ap-selfbot-title"]' });

    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    discord('spam-filters-discord', () => ({
        channel: 'mod-log', ctx: ctxNames,
        messages: [{
            username: 'CertiFried Utility', avatarUrl: `${B()}/images/CertiFried.png`,
            embeds: [{
                color: '#ff6600', title: '🤖 SELF-BOT BEHAVIOR DETECTED', timestamp: true,
                description: `Automated/bot-like behavior detected from **${M.spam.username}**`,
                thumbnail: ctx.av('spam'),
                fields: [
                    { name: 'User', value: `<@${M.spam.id}> (${M.spam.id})`, inline: true },
                    { name: 'Overall Confidence', value: '70%', inline: true },
                    { name: 'Action Taken', value: 'alert', inline: true },
                    { name: 'Detection Signals', value: '💨 Message Burst\n└ 24 messages in 1000ms (60% confidence)\n\n⚡ Inhuman Response Times\n└ Avg: 31ms (4 occurrences) (80% confidence)', inline: false },
                ],
                footer: 'Detection ID: 12 | Self-Bot Detection System',
            }],
            buttons: [
                { label: 'Kick', style: 'danger' }, { label: 'Ban', style: 'danger' },
                { label: 'False Positive', style: 'secondary' }, { label: 'View History', style: 'primary' },
            ],
            buttonEmoji: ['👢', '🔨', '↩️', '📜'],
        }],
    }), { alt: 'A self-bot alert in #mod-log: a message burst and inhuman response times, 70% confidence, alert only, with Kick, Ban, False Positive and View History buttons.', guides: ['spam-filters'] });
}
