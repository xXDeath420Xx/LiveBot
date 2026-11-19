import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUpdater } from '../src/updater.js';

const ENV = `# comment that must survive
UPDATE_ON_START=false
SERVER_NAME=The Pacific
INVITE_CODE=89628253
`;

async function fixture(build = '0.10.0.8.10-old') {
    const composeDir = await mkdtemp(path.join(tmpdir(), 'wr-up-'));
    const serverFiles = await mkdtemp(path.join(tmpdir(), 'wr-sf-'));
    await writeFile(path.join(composeDir, '.env'), ENV);
    await mkdir(path.join(serverFiles, 'R5'), { recursive: true });
    await writeFile(path.join(serverFiles, 'R5', 'ServerDescription.json'),
        JSON.stringify({ DeploymentId: build, ServerDescription_Persistent: {} }));
    return { composeDir, serverFiles };
}

const docker = { inspect: async () => ({ Config: { Image: 'img' }, Image: 'sha256:abc123def456', State: {} }) };

test('flips UPDATE_ON_START on for the update and restores it after', async () => {
    // The flag is false by design so an unattended restart cannot pull a build
    // that breaks Windrose+. Leaving it on would reintroduce exactly that.
    const { composeDir, serverFiles } = await fixture();
    let flagDuringRun = null;

    const exec = async () => {
        flagDuringRun = (await readFile(path.join(composeDir, '.env'), 'utf8')).match(/^UPDATE_ON_START=(.*)$/m)[1];
        // Simulate the server writing a new build after the recreate.
        await writeFile(path.join(serverFiles, 'R5', 'ServerDescription.json'),
            JSON.stringify({ DeploymentId: '0.10.0.9.32-new', ServerDescription_Persistent: {} }));
        return { stdout: 'Recreated', stderr: '' };
    };

    const u = createUpdater({ composeDir, serverFiles, docker, exec, sleep: async () => {} });
    const out = await u.updateGame({ waitMs: 1000, pollMs: 1 });

    assert.equal(flagDuringRun, 'true', 'must be on during the recreate');
    assert.equal(out.updated, true);
    assert.equal(out.buildBefore, '0.10.0.8.10-old');
    assert.equal(out.buildAfter, '0.10.0.9.32-new');

    const after = await readFile(path.join(composeDir, '.env'), 'utf8');
    assert.match(after, /^UPDATE_ON_START=false$/m, 'flag must be restored');
    assert.match(after, /# comment that must survive/, 'comments preserved');
    assert.match(after, /^SERVER_NAME=The Pacific$/m, 'other keys untouched');
});

test('restores the flag even when the recreate throws', async () => {
    // An aborted update that leaves the flag on is a silent trap for the next
    // restart, which is the failure this whole design avoids.
    const { composeDir, serverFiles } = await fixture();
    const exec = async () => { throw new Error('compose blew up'); };

    const u = createUpdater({ composeDir, serverFiles, docker, exec, sleep: async () => {} });
    await assert.rejects(u.updateGame({ waitMs: 10, pollMs: 1 }), /compose blew up/);

    const after = await readFile(path.join(composeDir, '.env'), 'utf8');
    assert.match(after, /^UPDATE_ON_START=false$/m);
});

test('reports honestly when no new build appears', async () => {
    const { composeDir, serverFiles } = await fixture();
    const exec = async () => ({ stdout: 'Recreated', stderr: '' });

    const u = createUpdater({ composeDir, serverFiles, docker, exec, sleep: async () => {} });
    const out = await u.updateGame({ waitMs: 5, pollMs: 1 });

    assert.equal(out.updated, false);
    assert.equal(out.timedOut, true);
    assert.match(out.note, /still be running/);
});

test('current() surfaces the game build, not just the image digest', async () => {
    // A DeploymentId mismatch is what rejects players; the image digest tells
    // you nothing about it.
    const { composeDir, serverFiles } = await fixture('0.10.0.9.32-new');
    const u = createUpdater({ composeDir, serverFiles, docker, exec: async () => ({ stdout: '', stderr: '' }) });
    const cur = await u.current();
    assert.equal(cur.gameBuild, '0.10.0.9.32-new');
    assert.equal(cur.digest, 'abc123def456');
});
