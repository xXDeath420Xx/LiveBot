// Screenshots for the chat-games guide. Formats copied from: core/counting-manager.js (handleMessage, handleBadCount:
// the ✅ and ❌ reactions and the "Count Reset!" embed), dashboard/routes/api/features/counting.js (the page's data).
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, member: M } = demo;
    const BOT = 'CertiFried Utility';
    // Invented for these shots (fake id range).
    const counting = { id: '100400000000000091', name: 'counting' };
    const ctxNames = {
        channels: [...channels, counting].map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });
    const person = (k, content, extra) => ({ username: M[k].displayName, avatarUrl: ctx.av(k), bot: false, content, ...extra });

    // A member posts twice in a row: ❌ on their number, then the reset embed (danger colour, inline fields).
    discord('chat-games-discord', () => ({
        channel: counting.name, topic: 'Count up together. Nobody counts twice in a row.', ctx: ctxNames,
        messages: [
            person('wren', '41', { time: 'Today at 7:40 PM', reactions: [{ emoji: '✅', count: 1 }] }),
            person('hazel', '42', { time: 'Today at 7:41 PM', reactions: [{ emoji: '✅', count: 1 }] }),
            person('hazel', '43', { time: 'Today at 7:41 PM', reactions: [{ emoji: '❌', count: 1 }] }),
            bot({
                time: 'Today at 7:41 PM',
                embeds: [{
                    color: '#ED4245', title: '🔄 Count Reset!',
                    description: `<@${M.hazel.id}> counted twice in a row! Count reset to **0**.`,
                    fields: [
                        { name: 'Failed At', value: '42', inline: true }, { name: 'Expected', value: '43', inline: true },
                        { name: 'Got', value: '43', inline: true }, { name: 'Next Number', value: '1', inline: true },
                    ],
                    timestamp: true,
                }],
            }),
        ],
    }), { alt: 'A counting channel: Wren posts 41 and Hazel 42, both with a check mark. Hazel then posts 43 as well, and the bot resets the count to 0.', guides: ['chat-games'] });

    // The Counting page loads its channels from /api/guilds/:id/counting after rendering.
    ctx.stub(/^\/api\/guilds\/\d+\/counting\/?$/, () => ({
        channels: [
            { id: 1, channel_id: counting.id, channel_name: counting.name, is_active: true, current_count: 1286, next_number: 1287, highest_count: 2210, reset_count: 14,
                fail_mode: 'reset', react_on_valid: true, announce_milestones: true, delete_chatter: false },
        ],
    }));
    manage('chat-games-counting-page', 'counting', {}, {
        alt: 'The Counting page: the form to start counting in a channel, then #counting with 1287 as the next number, its record and resets, and Reset to 0 chosen for a wrong number.',
        guides: ['chat-games'], scrollTo: '#cnt-add-title', height: 900,
    });
}
