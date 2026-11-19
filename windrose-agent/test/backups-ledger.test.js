import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackups, META_SUFFIX } from '../src/backups.js';

// Who took a snapshot and why travels with the file (<zip>.meta.json), because the agent has no
// database — the dashboard copies it into windrose_backups when it lists backups.

const WORLD = '5A93CB6B298040910A84D5A2C2EF6285';
const SAVE = 'R5/Saved/SaveProfiles/Default';
const quiet = { warn() {}, info() {}, error() {} };
const stoppedDocker = { state: async () => ({ running: false, exists: true }) };

async function fixture() {
    const serverFiles = await mkdtemp(path.join(tmpdir(), 'wr-srv-'));
    const backupDir = await mkdtemp(path.join(tmpdir(), 'wr-bak-'));
    await mkdir(path.join(serverFiles, 'R5'), { recursive: true });
    await writeFile(path.join(serverFiles, 'R5', 'ServerDescription.json'), JSON.stringify({
        ServerDescription_Persistent: { WorldIslandId: WORLD },
    }));
    const gameBackups = path.join(serverFiles, SAVE, 'RocksDB_v2_Backups', 'Worlds', WORLD);
    await mkdir(gameBackups, { recursive: true });
    await writeFile(path.join(gameBackups, `${WORLD}_0.10.0_20260808-234544.zip`), 'NEW');
    return { serverFiles, backupDir };
}

test('snapshot writes a ledger sidecar and list() returns author, kind and label', async () => {
    const { serverFiles, backupDir } = await fixture();
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker, logger: quiet });

    const out = await backups.snapshot({ kind: 'manual', createdBy: '123456789012345678', label: 'pre update!' });
    assert.equal(out.createdBy, '123456789012345678');
    assert.equal(out.label, 'preupdate');

    const meta = JSON.parse(await readFile(path.join(backupDir, `${out.filename}${META_SUFFIX}`), 'utf8'));
    assert.equal(meta.kind, 'manual');
    assert.equal(meta.createdBy, '123456789012345678');

    const [listed] = await backups.list();
    assert.equal(listed.filename, out.filename, 'sidecars must not show up as backups');
    assert.equal(listed.createdBy, '123456789012345678');
    assert.equal(listed.kind, 'manual');
    assert.equal(listed.label, 'preupdate');
});

test('backups without a sidecar still list, with null ledger fields', async () => {
    const { serverFiles, backupDir } = await fixture();
    await writeFile(path.join(backupDir, 'old.zip'), 'x');
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker, logger: quiet });
    const [row] = await backups.list();
    assert.equal(row.filename, 'old.zip');
    assert.equal(row.createdBy, null);
    assert.equal(row.kind, null);
});

test('prune removes the sidecar with its backup', async () => {
    const { serverFiles, backupDir } = await fixture();
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker, logger: quiet });
    await backups.snapshot({ kind: 'scheduled' });
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(path.join(backupDir, 'newer.zip'), 'n');

    const pruned = await backups.prune({ keep: 1 });
    assert.equal(pruned.removed.length, 1);
    assert.deepEqual(await readdir(backupDir), ['newer.zip']);
});

test('restore records who triggered the pre-restore snapshot', async () => {
    const { serverFiles, backupDir } = await fixture();
    await writeFile(path.join(backupDir, 'snap.zip'), 'RESTORE-ME');
    const backups = createBackups({ serverFiles, backupDir, docker: stoppedDocker, logger: quiet });
    const out = await backups.restore({ filename: 'snap.zip', createdBy: '999999999999999999' });
    assert.equal(out.priorSnapshot.kind, 'pre-restore');
    assert.equal(out.priorSnapshot.createdBy, '999999999999999999');
});
