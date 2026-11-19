import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';

/*
 * /ban's request path (commands/admin/ban.js, core/ban-requests.js; register H-657).
 *   - Ban Members (or an approver role) bans; Kick Members (or a requester role) kicks and files a request.
 *     Requester roles used to come only from a table nothing wrote, so the request path never ran.
 *   - the roles and the request channel can be set: the Moderation page saves them through
 *     PUT /api/guilds/:id/moderation/ban-requests
 *   - /ban is not offered to everyone: it defaults to Kick Members
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banreq-'));
process.env.LOG_DIR ||= tmp;
const { banRequestRole, mayDecideBanRequest, parseBanRequestConfig } = await import('../core/ban-requests.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const A = '300000000000000001';
const R = '300000000000000002';

function member({ perms = [], roles = [] } = {}) {
    return {
        permissions: { has: (p) => perms.includes(p) },
        roles: { cache: { has: (id) => roles.includes(id) } },
    };
}

test('who bans, who requests', () => {
    const cfg = parseBanRequestConfig({ approver_role_ids: JSON.stringify([A]), requester_role_ids: JSON.stringify([R]) });
    assert.equal(banRequestRole(member({ perms: [PermissionFlagsBits.BanMembers] }), cfg), 'approver');
    assert.equal(banRequestRole(member({ roles: [A] }), cfg), 'approver');
    assert.equal(banRequestRole(member({ perms: [PermissionFlagsBits.KickMembers] }), cfg), 'requester', 'a moderator with Kick Members files a request without any setup');
    assert.equal(banRequestRole(member({ roles: [R] }), cfg), 'requester');
    assert.equal(banRequestRole(member(), cfg), null);
    assert.equal(banRequestRole(member({ perms: [PermissionFlagsBits.KickMembers], roles: [A] }), cfg), 'approver');
    assert.equal(mayDecideBanRequest(member({ roles: [R] }), cfg), false);
    assert.equal(mayDecideBanRequest(member({ roles: [A] }), cfg), true);
});

test('the stored config is read safely', () => {
    assert.deepEqual(parseBanRequestConfig(null), { channelId: null, approverRoleIds: [], requesterRoleIds: [] });
    assert.deepEqual(parseBanRequestConfig({ request_channel_id: '400000000000000001', approver_role_ids: 'not json', requester_role_ids: '["x", "300000000000000002", "300000000000000002"]' }),
        { channelId: '400000000000000001', approverRoleIds: [], requesterRoleIds: [R] });
});

test('/ban defaults to Kick Members and uses the shared rules', async () => {
    const { data } = await import('../commands/admin/ban.js');
    const json = data.toJSON();
    assert.equal(json.default_member_permissions, String(PermissionFlagsBits.KickMembers));
    const src = read('commands/admin/ban.js');
    assert.match(src, /banRequestRole\(me, cfg\)/);
    assert.match(read('interactions/buttons/ban_request.js'), /mayDecideBanRequest\(/);
});

test('the Moderation page can set the request channel and roles', () => {
    const api = read('dashboard/routes/api/features/moderation-messages.js');
    assert.match(api, /router\.put\('\/ban-requests'/);
    assert.match(api, /INSERT INTO ban_request_config/);
    const page = read('dashboard/views/partials/manage/moderation.ejs');
    for (const id of ['cfk-mod-banreq-channel', 'cfk-mod-banreq-approvers', 'cfk-mod-banreq-requesters', 'cfk-mod-banreq-save']) {
        assert.ok(page.includes(`id="${id}"`), `#${id}`);
    }
    assert.match(page, /\/moderation\/ban-requests/);
});
