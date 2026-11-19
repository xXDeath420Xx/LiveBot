import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFiles, createMods, FileError } from '../src/files.js';

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'wr-files-'));
    await mkdir(path.join(root, 'windrose_plus_mods'), { recursive: true });
    await mkdir(path.join(root, 'R5'), { recursive: true });
    await writeFile(path.join(root, 'notes.txt'), 'hello');
    await writeFile(path.join(root, 'windrose_plus.json'), JSON.stringify({ rcon: { password: 'SECRET' } }));
    return root;
}

test('rejects ../ traversal', async () => {
    const files = createFiles({ root: await fixture() });
    for (const p of ['../etc/passwd', '../../etc/passwd', 'R5/../../etc/passwd', 'a/../../..']) {
        await assert.rejects(files.list(p), FileError, `${p} should be rejected`);
    }
});

test('rejects absolute paths', async () => {
    const files = createFiles({ root: await fixture() });
    await assert.rejects(files.read('/etc/passwd'), /must be relative/);
});

test('rejects NUL bytes in paths', async () => {
    const files = createFiles({ root: await fixture() });
    await assert.rejects(files.read('notes.txt\0.png'), /invalid path/);
});

test('follows symlinks and rejects ones escaping the jail', async () => {
    // The classic broken jail does startsWith() on the UNRESOLVED path, which
    // this symlink walks straight through.
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'wr-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
    await symlink(outside, path.join(root, 'escape'));

    const files = createFiles({ root });
    await assert.rejects(files.read('escape/secret.txt'), /escapes server-files/);
    await assert.rejects(files.list('escape'), /escapes server-files/);
});

test('a sibling directory sharing the root prefix is not inside', async () => {
    // /srv/windrose/server-files-evil must not pass as inside
    // /srv/windrose/server-files.
    const base = await mkdtemp(path.join(tmpdir(), 'wr-prefix-'));
    const root = path.join(base, 'server-files');
    await mkdir(root);
    await mkdir(path.join(base, 'server-files-evil'));
    await writeFile(path.join(base, 'server-files-evil', 'x.txt'), 'nope');
    await symlink(path.join(base, 'server-files-evil'), path.join(root, 'link'));

    const files = createFiles({ root });
    await assert.rejects(files.read('link/x.txt'), /escapes server-files/);
});

test('blocks reading credential files', async () => {
    const files = createFiles({ root: await fixture() });
    await assert.rejects(files.read('windrose_plus.json'), /credentials/);
});

test('blocks writing executable extensions', async () => {
    // These get executed by Wine or the launcher on next boot — writing one
    // would turn the file manager into RCE inside the container.
    const files = createFiles({ root: await fixture() });
    for (const name of ['evil.dll', 'evil.exe', 'evil.bat', 'evil.ps1', 'mod.pak']) {
        await assert.rejects(files.write(name, 'x'), /blocked/, `${name} should be blocked`);
    }
});

test('allows ordinary reads, writes and listing inside the jail', async () => {
    const files = createFiles({ root: await fixture() });

    const listed = await files.list('.');
    assert.ok(listed.entries.some((e) => e.name === 'notes.txt'));

    assert.equal((await files.read('notes.txt')).content, 'hello');

    await files.write('sub.txt', 'written');
    assert.equal((await files.read('sub.txt')).content, 'written');
});

test('refuses to delete the jail root', async () => {
    const files = createFiles({ root: await fixture() });
    await assert.rejects(files.remove('.'), /refusing to delete/);
});

test('mod names may not contain path separators', async () => {
    const root = await fixture();
    const files = createFiles({ root });
    const mods = createMods({ files });

    for (const name of ['../evil', 'a/b', './x']) {
        await assert.rejects(mods.install({ name, initLua: 'print(1)' }), /may contain only/);
    }
});

test('installs and lists a Lua mod', async () => {
    const root = await fixture();
    const files = createFiles({ root });
    const mods = createMods({ files });

    const out = await mods.install({ name: 'welcome', manifest: { name: 'welcome', version: '1.0.0' }, initLua: 'print("hi")' });
    assert.match(out.note, /hot-reloads/);

    const listed = await mods.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'welcome');
    assert.equal(listed[0].valid, true);

    assert.equal(await readFile(path.join(root, 'windrose_plus_mods/welcome/init.lua'), 'utf8'), 'print("hi")');
});
