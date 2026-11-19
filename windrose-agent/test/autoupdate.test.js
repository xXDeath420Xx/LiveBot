import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAutoUpdate } from '../src/autoupdate.js';

function steamFetch(buildId) {
    return async () => ({
        ok: true,
        json: async () => ({ data: { 4129620: { depots: { branches: { public: { buildid: buildId, timeupdated: 1787642432 } } } } } }),
    });
}

async function harness({ buildId = '100', players = 0, logs = '', updated = true } = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'wr-au-'));
    const calls = [];
    const deps = {
        statePath: path.join(dir, 'autoupdate.json'),
        fetchImpl: steamFetch(buildId),
        updater: {
            updateGame: async () => {
                calls.push('updateGame');
                return { updated, buildBefore: 'old', buildAfter: updated ? 'new' : 'old', note: 'n' };
            },
        },
        docker: { logs: async () => logs, state: async () => ({ running: true }) },
        spool: { serverStatus: async () => ({ server: { player_count: players } }) },
        backups: { snapshot: async () => { calls.push('snapshot'); return { filename: 'snap.zip' }; } },
        logger: { info: () => {}, error: () => {} },
        enabled: true,
    };
    return { au: createAutoUpdate(deps), calls, statePath: deps.statePath };
}

test('first check seeds the baseline instead of updating', async () => {
    // A difference on the very first look means "we have never looked", not
    // "we are behind" — updating there would restart the server for nothing.
    const { au, calls } = await harness({ buildId: '100' });
    const out = await au.runCheck();
    assert.equal(out.action, 'seeded');
    assert.equal(calls.includes('updateGame'), false);
});

test('updates when Steam publishes a new build id', async () => {
    const { au, calls, statePath } = await harness({ buildId: '100' });
    await au.runCheck();                    // seed at 100
    au._t = null;
    const au2 = createAutoUpdate({
        statePath,
        fetchImpl: steamFetch('200'),
        updater: { updateGame: async () => { calls.push('updateGame'); return { updated: true, buildBefore: '100', buildAfter: '200' }; } },
        docker: { logs: async () => '', state: async () => ({ running: true }) },
        spool: { serverStatus: async () => ({ server: { player_count: 0 } }) },
        backups: { snapshot: async () => { calls.push('snapshot'); return { filename: 's.zip' }; } },
        logger: { info: () => {}, error: () => {} },
        enabled: true,
    });
    const out = await au2.runCheck();
    assert.equal(out.action, 'updated');
    assert.equal(out.trigger, 'steam build id changed');
    // Snapshot must precede the update, never the other way round.
    assert.deepEqual(calls.filter((c) => c !== 'updateGame' || true).slice(0, 2), ['snapshot', 'updateGame']);
});

test('a DeploymentId mismatch in the logs triggers an update on its own', async () => {
    // Independent of the Steam lookup: the game itself refused a real client,
    // which cannot be a false positive.
    const { au } = await harness({ buildId: '100', logs: 'DeploymentId mismatch. ServerDeploymentId x ClientDeploymentId y' });
    await au.runCheck();                    // seed
    const out = await au.runCheck();        // same build id, but a rejection is present
    assert.equal(out.action, 'updated');
    assert.match(out.trigger, /rejected/);
});

test('never updates while players are online', async () => {
    const { au, calls } = await harness({ buildId: '100', players: 3, logs: 'DeploymentId mismatch' });
    await au.runCheck();
    const out = await au.runCheck();
    assert.equal(out.action, 'deferred');
    assert.match(out.reason, /3 player/);
    assert.equal(calls.includes('updateGame'), false);
});

test('a stale mismatch line does not retrigger after an update', async () => {
    // The log still contains the rejection that caused the update; without a
    // guard that would update again on every tick forever.
    const { au, calls } = await harness({ buildId: '100', logs: 'DeploymentId mismatch' });
    await au.runCheck();       // seed
    await au.runCheck();       // updates
    const before = calls.filter((c) => c === 'updateGame').length;
    const out = await au.runCheck();
    assert.equal(out.action, 'none');
    assert.equal(calls.filter((c) => c === 'updateGame').length, before, 'must not update twice off one rejection');
});

test('honours a cooldown so a flapping build id cannot restart in a loop', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wr-au-cd-'));
    const statePath = path.join(dir, 'a.json');
    let build = '100';
    const calls = [];
    const mk = () => createAutoUpdate({
        statePath,
        fetchImpl: async () => ({ ok: true, json: async () => ({ data: { 4129620: { depots: { branches: { public: { buildid: build } } } } } }) }),
        updater: { updateGame: async () => { calls.push('u'); return { updated: true, buildBefore: 'a', buildAfter: 'b' }; } },
        docker: { logs: async () => '', state: async () => ({ running: true }) },
        spool: { serverStatus: async () => ({ server: { player_count: 0 } }) },
        backups: { snapshot: async () => ({ filename: 's.zip' }) },
        logger: { info: () => {}, error: () => {} },
        enabled: true,
    });

    await mk().runCheck();          // seed at 100
    build = '200';
    assert.equal((await mk().runCheck()).action, 'updated');
    build = '300';                  // remote flaps again immediately
    const out = await mk().runCheck();
    assert.equal(out.action, 'deferred');
    assert.match(out.reason, /minutes ago/);
    assert.equal(calls.length, 1, 'only the first update should have run');
});

test('records that the server failed to come back', async () => {
    // The whole point of an unattended update is that nobody is watching, so a
    // server that does not return must be recorded rather than assumed fine.
    const dir = await mkdtemp(path.join(tmpdir(), 'wr-au2-'));
    const statePath = path.join(dir, 'autoupdate.json');
    const au = createAutoUpdate({
        statePath,
        fetchImpl: steamFetch('100'),
        updater: { updateGame: async () => ({ updated: true, buildBefore: 'a', buildAfter: 'b' }) },
        docker: { logs: async () => 'DeploymentId mismatch', state: async () => ({ running: false }) },
        spool: { serverStatus: async () => ({ server: { player_count: 0 } }) },
        backups: { snapshot: async () => ({ filename: 's.zip' }) },
        logger: { info: () => {}, error: () => {} },
        enabled: true,
    });
    await au.runCheck();
    const out = await au.runCheck();
    assert.equal(out.healthy, false);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.lastResult.healthy, false);
});

test('a failed Steam lookup does not stop the log-based trigger', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wr-au3-'));
    const au = createAutoUpdate({
        statePath: path.join(dir, 'a.json'),
        fetchImpl: async () => { throw new Error('network down'); },
        updater: { updateGame: async () => ({ updated: true, buildBefore: 'a', buildAfter: 'b' }) },
        docker: { logs: async () => 'DeploymentId mismatch', state: async () => ({ running: true }) },
        spool: { serverStatus: async () => ({ server: { player_count: 0 } }) },
        backups: { snapshot: async () => ({ filename: 's.zip' }) },
        logger: { info: () => {}, error: () => {} },
        enabled: true,
    });
    const out = await au.runCheck();
    assert.equal(out.action, 'updated', 'the reactive signal needs no network');
});

test('enablement comes from the environment, and defaults to off', async () => {
    // Hermetic: this asserted a global default and broke the moment the real
    // .env turned auto-update on, which made the test a property of the host.
    const dir = await mkdtemp(path.join(tmpdir(), 'wr-au4-'));
    const prev = process.env.WINDROSE_AUTOUPDATE;
    try {
        delete process.env.WINDROSE_AUTOUPDATE;
        const off = createAutoUpdate({ statePath: path.join(dir, 'a.json'), fetchImpl: steamFetch('1') });
        assert.equal(off.enabled, false, 'unset means off');
        assert.deepEqual(off.start(), { scheduled: false });

        process.env.WINDROSE_AUTOUPDATE = 'true';
        const on = createAutoUpdate({ statePath: path.join(dir, 'b.json'), fetchImpl: steamFetch('1') });
        assert.equal(on.enabled, true);
        on.stop();
    } finally {
        if (prev === undefined) delete process.env.WINDROSE_AUTOUPDATE;
        else process.env.WINDROSE_AUTOUPDATE = prev;
    }
});
