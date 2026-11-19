/*
 * The "tidy" wave: the two automod modules (core/automod.js, core/advanced-automod-manager.js) raise the shared
 * "Manual action needed" alert through actOrReport (core/manual-action.js) when the bot cannot act, like every
 * other automated punitive path; `/avatarfilter export|import` reuses the dashboard's avatar export / import;
 * the stale one-off setup scripts that wrote anti_raid_config are gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PermissionFlagsBits } from 'discord.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const exists = (f) => fs.existsSync(new URL(`../${f}`, import.meta.url));

test('every automated punitive path raises "Manual action needed" when the bot cannot act', () => {
    const wired = [
        'core/automod.js', 'core/advanced-automod-manager.js', 'core/adaptive-spam-manager.js',
        'core/phishing-detection-manager.js', 'core/selfbot-detection-manager.js', 'core/raid-detection-manager.js',
        'core/raid-lockdown.js', 'core/join-gate.js', 'core/spammer-guard.js', 'core/name-filters.js',
        'core/avatar-protection.js', 'core/nsfw-protection.js', 'core/message-threats.js', 'core/verification.js',
        'core/auto-prune.js', 'core/global-ban-manager.js', 'jobs/temp-access-reaper.js',
    ];
    for (const f of wired) {
        const src = read(f);
        assert.match(src, /from '\.\.?\/(core\/)?manual-action\.js'/, `${f} must use core/manual-action.js`);
        // global-ban-manager only pre-flights (whyCannot) and hands the result to the protection that reports it.
        assert.match(src, /\b(reportManualAction|actOrReport|whyCannot)\(/, `${f} must check / raise the alert`);
    }
});

test('the automod modules run every delete / timeout / kick / ban through actOrReport', () => {
    for (const f of ['core/automod.js', 'core/advanced-automod-manager.js']) {
        const lines = read(f).split('\n');
        const acts = lines.map((l, i) => [l, i + 1]).filter(([l]) =>
            /\b(member|message\.member)\.(timeout|kick|ban)\(|\bbulkDelete\(|\bmessage\.delete\(\)/.test(l) && !/^\s*(\/\/|\*)/.test(l));
        assert.ok(acts.length >= 5, `${f}: expected the rule actions to be found`);
        for (const [l, n] of acts) {
            // The call may wrap: the action on the line after `actOrReport(…,`.
            assert.ok(/actOrReport\(/.test(l) || /actOrReport\(.*,\s*$/.test(lines[n - 2]), `${f}:${n} acts without actOrReport: ${l.trim()}`);
        }
        // The old silent skips: an un-kickable member was just left alone with nothing said.
        assert.doesNotMatch(read(f), /\.(moderatable|kickable|bannable)\b/, `${f} must not skip silently on moderatable/kickable/bannable`);
        assert.doesNotMatch(read(f), /message\.delete\(\)\.catch\(\(\) => \{\}\)/, `${f} must not swallow a failed delete`);
        assert.match(read(f), /await protectionHold\(/, `${f} still asks protectionHold first`);
    }
});

// ── actOrReport against a fake guild (no Discord) ─────────────────────────────────────────────────────

const perms = (...flags) => ({ has: (p) => flags.includes(p) });
function fakeGuild(botFlags, { me = true, botTop = 10 } = {}) {
    return {
        id: 'tidy-test-guild', name: 'Tidy test', ownerId: 'owner-1',
        members: { me: me ? { id: 'bot', permissions: perms(...botFlags), roles: { highest: { position: botTop, name: 'Bot' } } } : null },
    };
}
const member = (top = 1, id = 'm-1') => ({ id, user: { id, tag: 'm#0' }, roles: { highest: { position: top, name: 'Member', id: 'r-1' } }, permissions: perms() });
const refusal = (code) => Object.assign(new Error(`Discord ${code}`), { code });

test('actOrReport: acts when the bot can, and only then', async () => {
    const { actOrReport } = await import('../core/manual-action.js');
    let ran = 0;
    const ok = await actOrReport(fakeGuild([PermissionFlagsBits.ModerateMembers]), 'timeout', { member: member(), source: 'Test' }, async () => { ran++; });
    assert.equal(ok, true);
    assert.equal(ran, 1);
});

test('actOrReport: missing permission or a higher member means no attempt and false', async () => {
    const { actOrReport } = await import('../core/manual-action.js');
    let ran = 0;
    const fn = async () => { ran++; };
    assert.equal(await actOrReport(fakeGuild([]), 'kick', { member: member(), source: 'Test' }, fn), false);
    assert.equal(await actOrReport(fakeGuild([PermissionFlagsBits.BanMembers]), 'ban', { member: member(20), source: 'Test' }, fn), false);
    assert.equal(await actOrReport(fakeGuild([PermissionFlagsBits.BanMembers]), 'ban', { member: member(1, 'owner-1'), source: 'Test' }, fn), false);
    const channel = { permissionsFor: () => perms() };
    assert.equal(await actOrReport(fakeGuild([PermissionFlagsBits.ManageMessages]), 'delete', { member: member(), channel, source: 'Test' }, fn), false,
        'Manage Messages is judged in the channel');
    assert.equal(ran, 0);
});

test('actOrReport: a member who left is not an alert and not an attempt (timeout / kick)', async () => {
    const { actOrReport } = await import('../core/manual-action.js');
    let ran = 0;
    assert.equal(await actOrReport(fakeGuild([PermissionFlagsBits.ModerateMembers]), 'timeout', { member: null, source: 'Test' }, async () => { ran++; }), false);
    assert.equal(ran, 0);
});

test('actOrReport: a Discord refusal or any other failure never throws and returns false', async () => {
    const { actOrReport } = await import('../core/manual-action.js');
    const g = fakeGuild([PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageMessages]);
    for (const code of [50013, 50001, 10007, 10008, undefined]) {
        assert.equal(await actOrReport(g, 'kick', { member: member(), source: 'Test' }, async () => { throw refusal(code); }), false, `code ${code}`);
    }
    assert.equal(await actOrReport(g, 'delete', { member: member(), source: 'Test' }, async () => { throw refusal(10008); }), false);
});

test('actOrReport: a cold cache (bot member not cached) still attempts the action', async () => {
    const { actOrReport } = await import('../core/manual-action.js');
    let ran = 0;
    assert.equal(await actOrReport(fakeGuild([], { me: false }), 'ban', { member: member(), source: 'Test' }, async () => { ran++; }), true);
    assert.equal(ran, 1);
    assert.equal(await actOrReport(fakeGuild([], { me: false }), 'ban', { member: member(), source: 'Test' }, async () => { throw refusal(50013); }), false);
});

// ── /avatarfilter export | import ─────────────────────────────────────────────────────────────────────

test('/avatarfilter has export and import, on the dashboard\'s avatar export / import', async () => {
    const { default: cmd } = await import('../commands/admin/avatarfilter.js');
    const json = cmd.data.toJSON();
    const subs = json.options.filter(o => o.type === 1).map(o => o.name);
    assert.ok(subs.includes('export') && subs.includes('import'), subs.join(','));
    assert.ok(json.options.length <= 25);
    const imp = json.options.find(o => o.name === 'import');
    assert.deepEqual(imp.options.map(o => [o.name, o.type, o.required]), [['file', 11, true]]);
    const size = (o) => (o.name?.length ?? 0) + (o.description?.length ?? 0)
        + (o.choices || []).reduce((n, c) => n + c.name.length + String(c.value).length, 0) + (o.options || []).reduce((n, c) => n + size(c), 0);
    assert.ok(size(json) <= 8000, `command is ${size(json)} characters (limit 8000)`);
    for (const o of json.options) assert.ok(o.description.length <= 100, o.name);
    const src = read('commands/admin/avatarfilter.js');
    assert.match(src, /ap\.exportProtected\(guild\)/);
    assert.match(src, /ap\.importProtected\(guild, text, \{ apply: false \}\)/);
    assert.match(src, /avatarfilter_import:\$\{token\}/);
    const btn = read('interactions/buttons/avatar_filter.js');
    assert.match(btn, /ap\.importProtected\(interaction\.guild, entry\.text, \{ apply: true \}, interaction\.user\.id\)/);
    assert.match(btn, /entry\.kind !== 'avatar-import'/);
    assert.match(read('interactions/handlerRegistry.js'), /'avatarfilter_import:': handleAvatarFilterImport/);
});

test('the avatar export file the command sends is the dashboard\'s format, and it imports back', async () => {
    const AV = await import('../core/avatar-match-logic.js');
    const rows = [{ kind: 'scam_avatar', label: 'Scam', dhash: '0123456789abcdef', bits_set: 30, colour_sig: 'a'.repeat(96), exact_sha: 'b'.repeat(64), avatar_fp: null }];
    const data = AV.buildAvatarExport(rows, { guildId: '1', guildName: 'x' });
    const text = JSON.stringify(data, null, 2);
    const plan = AV.planAvatarImport(text, []);
    assert.equal(plan.ok, true);
    assert.equal(plan.add.length, 1);
    assert.equal(AV.planAvatarImport(text, [{ kind: 'scam_avatar', dhash: '0123456789abcdef', exact_sha: 'b'.repeat(64) }]).duplicates.length, 1);
});

test('stale one-off setup scripts that wrote anti_raid_config are gone', () => {
    assert.equal(exists('scripts/setup-anoraks-army.js'), false);
    assert.equal(exists('scripts/setup-guild-1099732505243959407.js'), false);
});
