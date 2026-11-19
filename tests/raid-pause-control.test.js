import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MOUNTS } from '../core/command-mounts.js';

/*
 * Raid detection wording and the DM / invite pause (register H-660).
 *   - /protection raid|selfbot config say what the columns really default to (purge off, alert only)
 *   - "Time out raiders (lockdown)" is gone: it never started a lockdown; migration 447 moved its rows to
 *     'mute', which does the same, and points to /lockdown for a real one
 *   - one pause control: /lockdown dms|invites and the dashboard switches (keep_* columns). /lockdown dm-pause
 *     and /lockdown discord are retired, switching off lifts a running pause, and the old dm_disable_enabled
 *     setting is moved to keep_dms_disabled (migration 447, and the old renewer for stragglers)
 */

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('help text matches the column defaults', () => {
    const src = read('commands/admin/protection.js');
    assert.doesNotMatch(src, /purge_messages'\)\.setDescription\('[^']*\(default: true\)/, 'purge is off by default');
    assert.equal((src.match(/Purge messages from detected (raiders|self-bots) \(default: off\)/g) || []).length, 2);
    assert.doesNotMatch(src, /value: 'lockdown'/, 'no lockdown choice that only times raiders out');
    const raid = read('commands/admin/protection/raid.js');
    assert.doesNotMatch(raid, /Action: Mute \+ Purge messages/, 'enable reports the real settings');
    assert.match(raid, /SELECT \* FROM raid_detection_config WHERE guild_id = \?/);
});

test('the dashboard no longer offers the misleading lockdown action', () => {
    const page = read('dashboard/views/partials/manage/advanced-protection.ejs');
    assert.doesNotMatch(page, /<option value="lockdown"/);
    assert.doesNotMatch(page, /Time out raiders \(lockdown\)/);
    assert.match(page, /use Raid lockdown below/);
});

test('one DM / invite pause control', () => {
    assert.ok(!('dm-disable' in MOUNTS) && !('server-lockdown' in MOUNTS), 'retired subcommands are not mounted');
    assert.ok(!fs.existsSync(path.join(ROOT, 'commands/admin/dm-disable.js')), '/lockdown dm-pause is gone');
    assert.ok(!fs.existsSync(path.join(ROOT, 'commands/admin/server-lockdown.js')), '/lockdown discord is gone');
    assert.match(read('commands/admin/lockdown.js'), /syncIncidents\(interaction\.guild, \{ why: `\/lockdown \$\{kind\} by \$\{interaction\.user\.username\}`, lift: \{ \[kind\]: !enabled \} \}\)/);
    assert.match(read('dashboard/routes/api/features/raid-lockdown.js'), /lift: \{ \[kind\]: !req\.body\.enabled \}/);
    const renewer = read('jobs/dm-disable-renewer.js');
    assert.match(renewer, /saveSettings\(guildId, \{ keep_dms_disabled: 1 \}\)/);
    assert.doesNotMatch(renewer, /setIncidentActions/, 'no second renewer writing to Discord');
    const mig = read('migrations/447_raid_pause_one_model.js');
    assert.match(mig, /SET action = 'mute' WHERE action = 'lockdown'/);
    assert.match(mig, /ON DUPLICATE KEY UPDATE keep_dms_disabled = 1/);
});
