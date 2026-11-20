// Screenshots for the scam-links guide. Formats copied from: core/phishing-detection-manager.js (takeAction alert
// embed, themeColor danger #ED4245 from core/guild-theme.js), dashboard/views/partials/manage/phishing.ejs.
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, channel, member: M } = demo;
    // An invented evidence channel for the "Report and evidence channel" field (fake id).
    const evidence = { id: '100400000000000091', name: 'scam-evidence', type: 0, parentId: null };

    manage('scam-links-page', 'phishing', {
        channels: [...channels, evidence],
        phishingConfig: {
            enabled: 1, action: 'delete', mute_duration_minutes: 30, alert_channel_id: channel['mod-log'].id,
            log_detections: 1, scan_images: 1, exempt_channels: '[]', report_channel_id: evidence.id,
            whitelist_domains: '[]',
        },
    }, { alt: 'The Phishing links page: phishing detection switched on, the action set to delete the message, alerts going to #mod-log and the detection log kept.', guides: ['scam-links'] });

    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    discord('scam-links-discord', () => ({
        channel: 'mod-log', ctx: ctxNames,
        messages: [{
            username: 'CertiFried Utility', avatarUrl: `${B()}/images/CertiFried.png`,
            embeds: [{
                color: '#ED4245', title: 'Phishing Link Detected', timestamp: true,
                description: `A message in <#${channel.general.id}> contained a known phishing domain.`,
                fields: [
                    { name: 'User', value: `<@${M.spam.id}> (${M.spam.username})`, inline: true },
                    { name: 'Account Age', value: '2 days ago', inline: true },
                    { name: 'Action Taken', value: 'delete', inline: true },
                    { name: 'Matched Domain', value: '`free-nitro-drop.example`', inline: true },
                    { name: 'Full URL', value: 'https://free-nitro-drop.example/claim', inline: false },
                    { name: 'Channel', value: `<#${channel.general.id}>`, inline: true },
                ],
                footer: `User ID: ${M.spam.id}`,
            }],
        }],
    }), { alt: 'A Phishing Link Detected alert in #mod-log: the member, their account age, the action taken, the matched domain, the full link and the channel.', guides: ['scam-links'] });
}
