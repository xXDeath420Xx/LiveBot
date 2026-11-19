import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * /manage logs-setup (commands/admin/logs-setup.js, plan in core/logs-setup-plan.js; register H-656).
 *   - it routes Logging-page CATEGORIES, the keys core/log-manager.js looks up, never action keys
 *   - every category that can post is routed exactly once (bans, unbans, moderation, join gate and AutoMod
 *     actions included; nothing twice); a category added later falls back to the system log channel
 *   - it creates the logging_config row the log manager needs, keeps a server's own ticked categories,
 *     and only fills an empty default channel
 *   - the channels it creates are private
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-'));
process.env.LOG_DIR ||= tmp;
const { LOG_ACTIONS } = await import('../core/log-actions.js');
const { logsSetupPlan, planLoggingConfig, isNeverLogged, FALLBACK_CHANNEL } = await import('../core/logs-setup-plan.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ROOT = path.join(import.meta.dirname, '..');

test('every category that can post is routed exactly once, by its category key', () => {
    const plan = logsSetupPlan();
    const routed = plan.flatMap((g) => g.categories);
    assert.equal(new Set(routed).size, routed.length, 'no category routed twice');
    const loggable = Object.keys(LOG_ACTIONS).filter((c) => !isNeverLogged(c)).sort();
    assert.deepEqual([...routed].sort(), loggable);
    for (const key of routed) assert.ok(key in LOG_ACTIONS, `${key} is a Logging-page category`);
    for (const must of ['ban', 'unban', 'moderation', 'join-gate', 'automodAction', 'automod', 'memberJoin', 'memberUpdate', 'voiceUpdate']) {
        assert.ok(routed.includes(must), `${must} is routed`);
    }
    assert.ok(!routed.some((k) => /^(emoji|sticker|soundboard)/.test(k)), 'never-logged categories get no channel');
    assert.ok(plan.every((g) => g.categories.length > 0), 'no empty channel');
});

test('a category the plan does not name goes to the system log channel', () => {
    const plan = logsSetupPlan({ ...LOG_ACTIONS, brandNewThing: [{ key: 'brandNewThing', label: 'x', color: { hex: '#000000' } }] });
    assert.ok(plan.find((g) => g.name === FALLBACK_CHANNEL).categories.includes('brandNewThing'));
});

test('logging_config: created when missing, the server\'s ticked categories kept when saved', () => {
    const cats = ['ban', 'memberJoin', 'moderation'];
    const fresh = planLoggingConfig(null, cats);
    assert.deepEqual(fresh.enabledEvents, cats);
    assert.equal(fresh.setEvents, true);
    assert.equal(fresh.setDefaultChannel, true);
    assert.deepEqual(fresh.off, []);

    const noList = planLoggingConfig({ log_channel_id: '123456789012345678', enabled: 1, enabled_events: null }, cats);
    assert.equal(noList.setEvents, true, 'an empty list is filled, so categories that need a tick post too');
    assert.equal(noList.setDefaultChannel, false, 'a chosen default channel is kept');

    const chosen = planLoggingConfig({ log_channel_id: null, enabled: 0, enabled_events: '["ban","memberJoin"]' }, cats);
    assert.equal(chosen.setEvents, false);
    assert.deepEqual(chosen.enabledEvents, ['ban', 'memberJoin']);
    assert.deepEqual(chosen.off, ['moderation']);
    assert.equal(chosen.switchOn, true);
    assert.equal(chosen.setDefaultChannel, true);
});

test('the command writes category routing, the logging_config row and private channels', () => {
    const src = fs.readFileSync(path.join(ROOT, 'commands/admin/logs-setup.js'), 'utf8');
    assert.match(src, /INSERT INTO logging_config/);
    assert.match(src, /INSERT INTO log_event_config/);
    assert.match(src, /logsSetupPlan\(\)/);
    assert.doesNotMatch(src, /'automod\.removed'|'memberJoin\.joined'/, 'no action keys');
    const creates = [...src.matchAll(/guild\.channels\.create\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    assert.ok(creates.length >= 2);
    for (const c of creates) assert.match(c, /permissionOverwrites/, 'created channels are private');
});
