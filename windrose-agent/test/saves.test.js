import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSaves, SaveError } from '../src/saves.js';

const run = promisify(execFile);
const stoppedDocker = { state: async () => ({ running: false, exists: true }) };
const runningDocker = { state: async () => ({ running: true, exists: true }) };

const WORLD = 'ABCDEF0123456789ABCDEF0123456789';

async function fixture() {
    const serverFiles = await mkdtemp(path.join(tmpdir(), 'wr-sv-'));
    const uploadDir = await mkdtemp(path.join(tmpdir(), 'wr-up-'));
    await mkdir(path.join(serverFiles, 'R5'), { recursive: true });
    await writeFile(path.join(serverFiles, 'R5', 'ServerDescription.json'), JSON.stringify({
        Version: 1,
        ServerDescription_Persistent: { WorldIslandId: 'OLDWORLD', ServerName: 'CertiFried' },
    }, null, 4));
    await mkdir(path.join(serverFiles, 'R5/Saved/SaveProfiles/Default/RocksDB_v2/0.10.0/Worlds/OLDWORLD'), { recursive: true });
    return { serverFiles, uploadDir };
}

/** Build a zip shaped like a real engine checkpoint backup. */
async function makeSaveZip(dir, { islandId = WORLD, withDescription = true, hostilePath = false } = {}) {
    const stage = await mkdtemp(path.join(tmpdir(), 'wr-stage-'));
    await mkdir(path.join(stage, 'Checkpoint/private/1'), { recursive: true });
    await mkdir(path.join(stage, 'Checkpoint/shared_checksum'), { recursive: true });
    await mkdir(path.join(stage, 'Checkpoint/meta'), { recursive: true });
    await writeFile(path.join(stage, 'Checkpoint/meta/1'), 'meta');
    await writeFile(path.join(stage, 'Checkpoint/private/1/CURRENT'), 'MANIFEST-000061\n');
    await writeFile(path.join(stage, 'Checkpoint/private/1/MANIFEST-000061'), 'manifest');
    await writeFile(path.join(stage, 'Checkpoint/shared_checksum/000014_x_1214.sst'), 'sst');

    if (withDescription) {
        await mkdir(path.join(stage, 'AdditionalRecordFiles'), { recursive: true });
        await writeFile(path.join(stage, 'AdditionalRecordFiles/WorldDescription.json'), JSON.stringify({
            Version: 1,
            WorldDescription: { islandId, WorldName: 'Imported Isle', WorldPresetType: 'Hard', WorldSettings: {} },
        }));
    }

    const zipPath = path.join(dir, hostilePath ? 'hostile.zip' : 'save.zip');
    await run('zip', ['-r', '-q', zipPath, '.'], { cwd: stage });
    return zipPath;
}

test('accepts a well-formed engine checkpoint and reads its embedded description', async () => {
    // WorldDescription.json travels INSIDE the archive — that is how an import
    // knows which world it is adopting.
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const zip = await makeSaveZip(uploadDir);

    const info = await saves.inspect(zip);
    assert.equal(info.islandId, WORLD);
    assert.equal(info.worldName, 'Imported Isle');
    assert.equal(info.presetType, 'Hard');
    assert.equal(info.hasDescription, true);
});

test('rejects an archive that is not a world backup', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });

    const stage = await mkdtemp(path.join(tmpdir(), 'wr-junk-'));
    await writeFile(path.join(stage, 'holiday.jpg'), 'not a save');
    const zip = path.join(uploadDir, 'junk.zip');
    await run('zip', ['-r', '-q', zip, '.'], { cwd: stage });

    await assert.rejects(saves.inspect(zip), /does not look like a Windrose world save/);
});

test('rejects a file that is not a zip at all', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const bogus = path.join(uploadDir, 'nope.zip');
    await writeFile(bogus, 'this is plain text');
    await assert.rejects(saves.inspect(bogus), /not a readable zip/);
});

test('refuses to import while the server is running', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: runningDocker });
    const zip = await makeSaveZip(uploadDir);
    await assert.rejects(saves.importSave({ zipPath: zip }), /while the server is running/);
});

test('refuses to import an archive with no world id', async () => {
    // Without WorldDescription.json we cannot know which world to activate, and
    // guessing would point the server at nothing.
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const zip = await makeSaveZip(uploadDir, { withDescription: false });
    await assert.rejects(saves.importSave({ zipPath: zip }), /world id is unknown/);
});

test('import places the zip as _Latest and repoints ServerDescription', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const zip = await makeSaveZip(uploadDir);

    const out = await saves.importSave({ zipPath: zip, activate: true });

    assert.equal(out.activated, true);
    assert.equal(out.imported.islandId, WORLD);
    assert.match(out.appliedTo, new RegExp(`${WORLD}_0\\.10\\.0_Latest\\.zip$`));
    assert.equal(out.imported.format, 'checkpoint');

    const desc = JSON.parse(await readFile(path.join(serverFiles, 'R5', 'ServerDescription.json'), 'utf8'));
    assert.equal(desc.ServerDescription_Persistent.WorldIslandId, WORLD);
    // Unrelated fields must survive the rewrite.
    assert.equal(desc.ServerDescription_Persistent.ServerName, 'CertiFried');
});

test('import can stage without activating', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const zip = await makeSaveZip(uploadDir);

    const out = await saves.importSave({ zipPath: zip, activate: false });
    assert.equal(out.activated, false);

    const desc = JSON.parse(await readFile(path.join(serverFiles, 'R5', 'ServerDescription.json'), 'utf8'));
    assert.equal(desc.ServerDescription_Persistent.WorldIslandId, 'OLDWORLD');
});

test('import snapshots the outgoing world first', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const zip = await makeSaveZip(uploadDir);

    const calls = [];
    const backups = { snapshot: async (o) => { calls.push(o); return { filename: 'prior.zip', kind: o.kind }; } };

    const out = await saves.importSave({ zipPath: zip, backups });
    assert.equal(calls.length, 1, 'switching worlds must be undoable');
    assert.equal(out.priorSnapshot.kind, 'pre-restore');
});

test('activate validates the world id and rejects unknown worlds', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });

    await assert.rejects(saves.activate('../../etc'), /32-character hex/);
    await assert.rejects(saves.activate('nothex'), /32-character hex/);
    await assert.rejects(saves.activate(WORLD), /no world/);
});

test('lists worlds and marks the active one', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const out = await saves.list();
    assert.equal(out.activeWorldId, 'OLDWORLD');
    assert.equal(out.worlds.some((w) => w.islandId === 'OLDWORLD' && w.active), true);
});

test('export rejects path traversal', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    await assert.rejects(saves.exportPath('../../etc/passwd'), SaveError);
});

/** Build a zip shaped like a raw copy of Worlds/<islandId>/ — the format
 *  hand-rolled and third-party backup tools actually produce. */
async function makeWorldDirZip(dir, { islandId = WORLD, withLock = true } = {}) {
    const stage = await mkdtemp(path.join(tmpdir(), 'wr-wd-'));
    const world = path.join(stage, islandId);
    await mkdir(world, { recursive: true });
    await writeFile(path.join(world, 'CURRENT'), 'MANIFEST-5256300\n');
    await writeFile(path.join(world, 'MANIFEST-5256300'), 'manifest');
    await writeFile(path.join(world, 'IDENTITY'), 'id');
    await writeFile(path.join(world, '141731.sst'), 'sst-data');
    await writeFile(path.join(world, 'OPTIONS-5256290'), 'opts');
    if (withLock) await writeFile(path.join(world, 'LOCK'), '');
    await writeFile(path.join(world, 'WorldDescription.json'), JSON.stringify({
        Version: 1,
        WorldDescription: { islandId, WorldName: 'The Pacific', WorldPresetType: 'Medium', WorldSettings: {} },
    }));
    await writeFile(path.join(stage, 'BACKUP-INFO.txt'), 'Windrose server backup');
    await writeFile(path.join(stage, 'ServerDescription.json'), JSON.stringify({
        ServerDescription_Persistent: { ServerName: 'The Pacific', WorldIslandId: islandId, Password: 'pirates' },
    }));

    const zipPath = path.join(dir, 'worlddir.zip');
    await run('zip', ['-r', '-q', zipPath, '.'], { cwd: stage });
    return zipPath;
}

test('accepts a raw Worlds/<islandId>/ directory copy', async () => {
    // This is the shape most real backups take; refusing it and demanding an
    // engine zip was the wrong call.
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const zip = await makeWorldDirZip(uploadDir);

    const info = await saves.inspect(zip);
    assert.equal(info.format, 'worlddir');
    assert.equal(info.islandId, WORLD);
    assert.equal(info.worldName, 'The Pacific');
    // The source ServerDescription is read for display only, never applied.
    assert.equal(info.sourceServerName, 'The Pacific');
});

test('worlddir import extracts into place and drops the stale LOCK', async () => {
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const zip = await makeWorldDirZip(uploadDir);

    const out = await saves.importSave({ zipPath: zip, activate: true });
    assert.equal(out.imported.format, 'worlddir');

    const worldDir = path.join(serverFiles, 'R5/Saved/SaveProfiles/Default/RocksDB_v2/0.10.0/Worlds', WORLD);
    const files = await readdir(worldDir);
    assert.ok(files.includes('CURRENT'), 'CURRENT must be extracted');
    assert.ok(files.includes('141731.sst'), '.sst files must be extracted');
    assert.ok(files.includes('WorldDescription.json'));
    // RocksDB recreates LOCK; a stale one from another machine is at best noise.
    assert.equal(files.includes('LOCK'), false, 'stale LOCK must not be imported');
    // Flattened — no nested <islandId>/ inside the world dir.
    assert.equal(files.includes(WORLD), false);

    const desc = JSON.parse(await readFile(path.join(serverFiles, 'R5', 'ServerDescription.json'), 'utf8'));
    assert.equal(desc.ServerDescription_Persistent.WorldIslandId, WORLD);
});

test('never applies the source ServerDescription over ours', async () => {
    // The old host's ports, password and invite code must not leak in.
    const { serverFiles, uploadDir } = await fixture();
    const saves = createSaves({ serverFiles, uploadDir, docker: stoppedDocker });
    const zip = await makeWorldDirZip(uploadDir);

    await saves.importSave({ zipPath: zip, activate: true });
    const desc = JSON.parse(await readFile(path.join(serverFiles, 'R5', 'ServerDescription.json'), 'utf8'));
    assert.equal(desc.ServerDescription_Persistent.Password, undefined);
    assert.equal(desc.ServerDescription_Persistent.ServerName, 'CertiFried');
});
