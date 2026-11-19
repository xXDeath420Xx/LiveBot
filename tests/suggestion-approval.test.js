import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';

/*
 * H-662: "Require staff approval" did not hold suggestions back. They were posted publicly with
 * vote buttons straight away and the vote handler had no status check; the staff role could only
 * tag; the dashboard save never set allow_anonymous; /engage suggest setup reset require_approval
 * when the option was left out.
 */
const review = await import('../core/suggestion-review.js');
const { handleSuggestionUpvote } = await import('../interactions/buttons/suggestion_upvote.js');
const suggest = await import('../commands/community/engage-suggest-handler.js');
const { default: pool } = await import('../utils/db.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUILD = '100000000000000662';
const PUBLIC = '300000000000000662';
const REVIEW = '300000000000000663';
const STAFF_ROLE = '500000000000000662';
const AUTHOR = '200000000000000662';

test('approval rules: held while required, no votes while pending, staff role counts as staff', () => {
    assert.equal(review.holdsForReview({ require_approval: 1 }), true);
    assert.equal(review.holdsForReview({ require_approval: 0 }), false);
    assert.equal(review.votingOpen('pending'), false);
    assert.equal(review.votingOpen('approved'), true);

    const perms = (has) => ({ has: (p) => has && p === PermissionFlagsBits.ManageGuild });
    const roles = (ids) => ({ cache: new Set(ids) });
    const config = { approved_role_id: STAFF_ROLE };
    assert.equal(review.isSuggestionStaff({ permissions: perms(true), roles: roles([]) }, config), true);
    assert.equal(review.isSuggestionStaff({ permissions: perms(false), roles: roles([STAFF_ROLE]) }, config), true);
    assert.equal(review.isSuggestionStaff({ permissions: perms(false), roles: roles(['x']) }, config), false);
});

// ── A server with a suggestions channel and a staff review channel ──────────────────────────────
function fakeServer() {
    const sent = { review: [], public: [] };
    const messages = new Map();
    let n = 0;
    const channel = (kind, id) => ({
        id, type: 0,
        isTextBased: () => true,
        isThread: () => false,
        send: async (payload) => {
            const msg = {
                id: String(900000000000000000n + BigInt(++n)),
                embeds: (payload.embeds || []).map(e => (e.toJSON ? e.toJSON() : e)),
                components: (payload.components || []).map(c => (c.toJSON ? c.toJSON() : c)),
                edits: [],
            };
            msg.edit = async (p) => { msg.edits.push(p); };
            messages.set(msg.id, msg);
            sent[kind].push(msg);
            return msg;
        },
        messages: { fetch: async (mid) => messages.get(mid) || null },
    });
    const channels = new Map([[PUBLIC, channel('public', PUBLIC)], [REVIEW, channel('review', REVIEW)]]);
    const guild = { id: GUILD, name: 'Maple Hollow', channels: { cache: channels, fetch: async (id) => channels.get(id) || null } };
    const dms = [];
    const client = { users: { fetch: async () => ({ send: async (m) => { dms.push(m); } }) } };
    guild.client = client;
    return { guild, client, sent, dms };
}

async function cleanup() {
    const [rows] = await pool.execute('SELECT id FROM suggestions WHERE guild_id = ?', [GUILD]);
    for (const { id } of rows) await pool.execute('DELETE FROM suggestion_votes WHERE suggestion_id = ?', [id]);
    await pool.execute('DELETE FROM suggestions WHERE guild_id = ?', [GUILD]);
    await pool.execute('DELETE FROM user_suggestion_stats WHERE guild_id = ?', [GUILD]);
    await pool.execute('DELETE FROM suggestion_config WHERE guild_id = ?', [GUILD]);
}

async function configure(requireApproval) {
    await pool.execute(
        `INSERT INTO suggestion_config (guild_id, suggestions_channel_id, staff_review_channel_id, approved_role_id, require_approval, enabled, allow_anonymous)
         VALUES (?, ?, ?, ?, ?, 1, 0)`, [GUILD, PUBLIC, REVIEW, STAFF_ROLE, requireApproval ? 1 : 0]);
    return review.getSuggestionConfig(GUILD);
}

test('with approval required a suggestion waits in the review channel, unposted and closed to votes', async (t) => {
    t.after(cleanup);
    await cleanup();
    const config = await configure(true);
    const { guild, client, sent } = fakeServer();

    const { id, held } = await review.submitSuggestion({ client, guild, user: { id: AUTHOR, toString: () => `<@${AUTHOR}>` }, text: 'A screenshot contest', config });
    assert.equal(held, true);
    assert.equal(sent.public.length, 0, 'nothing in the voting channel');
    assert.equal(sent.review.length, 1, 'a review card for staff');
    const buttons = sent.review[0].components[0].components.map(b => b.custom_id);
    assert.deepEqual(buttons, [`sgr:approve:${id}`, `sgr:reject:${id}`]);

    const [[row]] = await pool.execute('SELECT status, message_id, review_message_id FROM suggestions WHERE id = ?', [id]);
    assert.equal(row.status, 'pending');
    assert.equal(row.message_id, null);
    assert.equal(row.review_message_id, sent.review[0].id);

    // A vote on it (an old pending post with buttons, say) is refused.
    let reply;
    await handleSuggestionUpvote({
        customId: `suggestion_upvote_${id}`, guild, user: { id: '200000000000000999' }, client,
        reply: async (r) => { reply = r; },
    });
    assert.match(reply.content, /waiting for staff approval/);
    const [votes] = await pool.execute('SELECT 1 FROM suggestion_votes WHERE suggestion_id = ?', [id]);
    assert.equal(votes.length, 0);
});

test('approving a held suggestion posts it for voting and closes the review card', async (t) => {
    t.after(cleanup);
    await cleanup();
    const config = await configure(true);
    const { guild, client, sent, dms } = fakeServer();
    const { id } = await review.submitSuggestion({ client, guild, user: { id: AUTHOR }, text: 'Movie nights', config });

    const result = await review.approveSuggestion({ client, guild, suggestionId: id, reviewerId: '600000000000000662', response: 'Good idea' });
    assert.deepEqual(result, { ok: true, posted: true });
    assert.equal(sent.public.length, 1, 'posted in the suggestions channel');
    assert.deepEqual(sent.public[0].components[0].components.map(b => b.custom_id), [`suggestion_upvote_${id}`, `suggestion_downvote_${id}`]);

    const [[row]] = await pool.execute('SELECT status, message_id FROM suggestions WHERE id = ?', [id]);
    assert.equal(row.status, 'approved');
    assert.equal(row.message_id, sent.public[0].id);

    const card = sent.review[0];
    assert.equal(card.edits.length, 1, 'review card edited');
    assert.deepEqual(card.edits[0].components, [], 'buttons removed');
    assert.equal(dms.length, 1, 'the member is told');
});

test('rejecting a held suggestion never posts it', async (t) => {
    t.after(cleanup);
    await cleanup();
    const config = await configure(true);
    const { guild, client, sent } = fakeServer();
    const { id } = await review.submitSuggestion({ client, guild, user: { id: AUTHOR }, text: 'Delete all channels', config });
    const result = await review.rejectSuggestion({ client, guild, suggestionId: id, reviewerId: '600000000000000662', reason: 'No' });
    assert.equal(result.ok, true);
    assert.equal(sent.public.length, 0);
    const [[row]] = await pool.execute('SELECT status FROM suggestions WHERE id = ?', [id]);
    assert.equal(row.status, 'rejected');
});

test('without approval a suggestion is posted for voting at once', async (t) => {
    t.after(cleanup);
    await cleanup();
    const config = await configure(false);
    const { guild, client, sent } = fakeServer();
    const { held } = await review.submitSuggestion({ client, guild, user: { id: AUTHOR }, text: 'More emoji', config });
    assert.equal(held, false);
    assert.equal(sent.public.length, 1);
    assert.equal(sent.review.length, 0);
});

test('the staff role can approve with the command; others cannot', async (t) => {
    t.after(cleanup);
    await cleanup();
    const config = await configure(true);
    const { guild, client, sent } = fakeServer();
    const { id } = await review.submitSuggestion({ client, guild, user: { id: AUTHOR }, text: 'Game night', config });

    const run = async (roleIds) => {
        const out = {};
        await suggest.handleApprove({
            guild, client, user: { id: '600000000000000662' },
            member: { permissions: { has: () => false }, roles: { cache: new Set(roleIds) } },
            options: { getInteger: () => id, getString: () => null },
            reply: async (r) => { out.reply = r; }, deferReply: async () => {}, editReply: async (r) => { out.edit = r; },
        });
        return out;
    };
    const denied = await run([]);
    assert.match(denied.reply.content, /staff role/);
    const allowed = await run([STAFF_ROLE]);
    assert.match(allowed.edit.content, /approved and posted for voting/);
    assert.equal(sent.public.length, 1);
});

test('/engage suggest setup without options keeps approval and anonymous settings', async (t) => {
    t.after(cleanup);
    await cleanup();
    await configure(true); // require_approval 1, allow_anonymous 0
    const { guild } = fakeServer();
    await suggest.handleSetup({
        guild, guildId: GUILD,
        member: { permissions: { has: () => true } },
        options: { getChannel: () => ({ id: PUBLIC, toString: () => `<#${PUBLIC}>` }), getBoolean: () => null },
        reply: async () => {},
    });
    const cfg = await review.getSuggestionConfig(GUILD);
    assert.equal(Number(cfg.require_approval), 1);
    assert.equal(Number(cfg.allow_anonymous), 0);
});

test('the dashboard saves the anonymous switch, and only from a page that has it', () => {
    const server = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    const route = server.slice(server.indexOf("app.post('/manage/:guildId/suggestions/config'"));
    const body = route.slice(0, route.indexOf('res.redirect'));
    assert.match(body, /allow_anonymous = IF\(\?, VALUES\(allow_anonymous\), allow_anonymous\)/);
    assert.match(body, /suggestions_form_v2/);
    assert.doesNotMatch(body, /allow_comments/);
    const view = fs.readFileSync(path.join(root, 'dashboard/views/partials/manage/suggestions.ejs'), 'utf8');
    assert.match(view, /name="allow_anonymous"/);
    assert.match(view, /name="suggestions_form_v2" value="1"/);
});
