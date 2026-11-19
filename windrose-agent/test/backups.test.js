import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackups } from '../src/backups.js';

const stoppedDocker = { state: async () => ({ running: false, exists: true }) };
const runningDocker = { state: async () => ({ running: true, exists: true }) };

const WORLD = '5A93CB6B298040910A84D5A2C2EF6285';
const SAVE = 'R5/Saved/SaveProfiles/Default';

async function fixture({ withSnapshots = true } = {}) {
    const serverFiles = await mkdtemp(path.join(tmpdir(), 'wr-srv-'));
    const backupDir = await mkdtemp(path.join(tmpdir(), 'wr-bak-'));

    await mkdir(path.join(serverFiles, 'R5'), { recursive: true });
    await writeFile(path.join(serverFiles, 'R5', 'ServerDescription.json'), JSON.stringify({
        ServerDescription_Persistent: { WorldIslandId: WORLD },
    }));

    const gameBackups = path.join(serverFiles, SAVE, 'RocksDB_v2_Backups', 'Worlds', WORLD);
    await mkdir(gameBackups, { recursive: true });

    if (withSnapshots) {
        // _Latest.zip is a moving alias the engine rewrites in place; the code
        // must prefer a stable timestamped file over it.
        await writeFile(path.join(gameBackups, `${WORLD}_0.10.0_Latest.zip`), 'LATEST');
        await writeFile(path.join(gameBackups, `${WORLD}_0.10.0_20260808-232544.zip`), 'OLD');
        await writeFile(path.join(gameBackups, `${WORLD}_0.10.0_20260808-234544.zip`), 'NEW');

        const old = new Date(Date.now() - 3600_000);
        await utimes(path.join(gameBackups, `${WORLD}_0.10.0_20260808-232544.zip`), old, old);
    }

    return { serverFiles, backupDir, gameBackups };
}

test('snapshots the newest timestamped engine zip, not _Latest', async () => {
    const { serverFiles, backupDir } = await fixture();
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker });

    const out = await backups.snapshot({ kind: 'manual' });

    assert.match(out.sourceSnapshot, /20260808-234544/, 'should pick the newest timestamped zip');
    assert.equal(await readFile(out.path, 'utf8'), 'NEW');
});

test('snapshot is allowed while the server is running', async () => {
    // The whole reason we copy the engine's sealed zips instead of tarring the
    // live RocksDB is that this is safe. Guard it against regression.
    const { serverFiles, backupDir } = await fixture();
    const backups = createBackups({ serverFiles, backupDir, docker: runningDocker });

    const out = await backups.snapshot({ kind: 'manual' });
    assert.ok(out.filename.endsWith('.zip'));
});

test('names the copy after the source snapshot, not the current time', async () => {
    const { serverFiles, backupDir } = await fixture();
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker });

    const out = await backups.snapshot({ kind: 'scheduled' });
    // A zip may be up to 10 minutes old; stamping it "now" would misrepresent
    // which world state it holds.
    assert.match(out.filename, /20260808-234544/);
    assert.match(out.filename, /_scheduled/);
});

test('reports a useful error when the engine has written no snapshot yet', async () => {
    const { serverFiles, backupDir } = await fixture({ withSnapshots: false });
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker });

    await assert.rejects(backups.snapshot(), /every ~10 minutes/);
});

test('list returns newest first and prune keeps the newest N', async () => {
    const { serverFiles, backupDir } = await fixture();
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker });

    for (const n of ['a', 'b', 'c']) {
        await writeFile(path.join(backupDir, `snap_${n}.zip`), n);
        await new Promise((r) => setTimeout(r, 10));
    }

    const listed = await backups.list();
    assert.equal(listed.length, 3);

    const pruned = await backups.prune({ keep: 1 });
    assert.equal(pruned.kept, 1);
    assert.equal(pruned.removed.length, 2);
    assert.equal((await readdir(backupDir)).length, 1);
});

test('refuses to restore while the server is running', async () => {
    const { serverFiles, backupDir } = await fixture();
    await writeFile(path.join(backupDir, 'snap.zip'), 'RESTORE-ME');
    const backups = createBackups({ serverFiles, backupDir, docker: runningDocker });

    await assert.rejects(backups.restore({ filename: 'snap.zip' }), /while the server is running/);
});

test('restore takes a pre-restore snapshot first', async () => {
    const { serverFiles, backupDir, gameBackups } = await fixture();
    await writeFile(path.join(backupDir, 'snap.zip'), 'RESTORE-ME');
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker });

    const out = await backups.restore({ filename: 'snap.zip' });

    assert.equal(out.priorSnapshot.kind, 'pre-restore', 'a mistaken restore must itself be undoable');
    assert.equal(await readFile(path.join(gameBackups, `${WORLD}_0.10.0_Latest.zip`), 'utf8'), 'RESTORE-ME');
});

test('rejects path traversal in the restore filename', async () => {
    const { serverFiles, backupDir } = await fixture();
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker });

    await assert.rejects(backups.restore({ filename: '../../etc/passwd' }), /invalid backup filename/);
});
