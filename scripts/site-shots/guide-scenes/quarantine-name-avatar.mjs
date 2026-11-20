// Screenshots for the quarantine-name-avatar guide. Formats copied from: commands/admin/namefilter.js (test reply;
// the folded form and the match come from core/name-filter-logic.js describeForms / matchNames / filterLabel run on
// "Jun1per V4le" against an Auto-Pilot exact filter for "Juniper Vale"), dashboard/views/partials/manage/quarantine.ejs.
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, roles, member: M, D } = demo;
    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);   // the local server's origin, once it runs
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });
    const names = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };

    // /moderation namefilter test name:Jun1per V4le (name checks on, fuzzy matching on, Auto-Pilot action kick).
    discord('quarantine-name-avatar-test', () => ({
        channel: 'mod-log', ctx: names,
        messages: [bot({
            usedBy: { name: M.hazel.displayName, command: '/moderation namefilter test' }, ephemeral: true,
            embeds: [{
                color: '#C0392B', title: 'Matches 1 filter(s)',
                fields: [
                    { name: 'username', value: '`Jun1per V4le` → folded `juniper vaie`' },
                    { name: 'Matches', value: '#9 exact "Juniper Vale" · kick · username (lookalikes folded)' },
                ],
            }],
        })],
    }), { alt: 'The private reply to a name filter test: Jun1per V4le, folded to juniper vaie, matches the exact filter Juniper Vale with the action kick.', guides: ['quarantine-name-avatar'] });

    // The Quarantine page with two invented suspects held.
    const qRole = { id: '100300000000000099', name: 'Quarantined', color: 0x5d6b7a, hexColor: '#5d6b7a', position: 1, managed: false, memberCount: 2 };
    manage('quarantine-name-avatar-page', 'quarantine', {
        roles: [...roles, qRole],
        quarantineConfig: { is_enabled: 1, quarantine_role_id: qRole.id },
        quarantinedUsers: [
            { user_id: '100100000000000099', username: 'jun1per.v4le', avatar_url: null, moderator_id: M.hazel.id, moderator_tag: M.hazel.displayName, reason: null, quarantined_at: D(2026, 11, 18, 21, 4) },
            { user_id: '100100000000000098', username: 'hollow.support.desk', avatar_url: null, moderator_id: M.rowan.id, moderator_tag: M.rowan.displayName, reason: null, quarantined_at: D(2026, 11, 17, 16, 40) },
        ],
    }, {
        alt: 'The Quarantine page: the Quarantined role is set, and two suspect accounts are held, each with a Release button.',
        guides: ['quarantine-name-avatar'], scrollTo: 'section[aria-labelledby="q-config-title"]',
    });
}
