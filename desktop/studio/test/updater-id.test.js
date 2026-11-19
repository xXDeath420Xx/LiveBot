'use strict';
/*
 * H-767 (0.2.5): the installed copy's update checks carry no per-install ID. electron-updater's staging ID is replaced by the
 * nil UUID before the first check, so no .updaterId file is written, and one left by 0.2.0-0.2.4 is deleted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { blankStagingId, NIL_UUID } = require('../src/main/updater');

test('every copy sends the nil staging ID and the old .updaterId file is removed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-upd-'));
    fs.writeFileSync(path.join(dir, '.updaterId'), '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    let made = 0;
    const au = { stagingUserIdPromise: { get value() { made++; return Promise.resolve('3f2504e0-4f89-11d3-9a0c-0305e82c3301'); } } };
    blankStagingId(au, dir);
    assert.equal(await au.stagingUserIdPromise.value, NIL_UUID);
    assert.equal(made, 0, 'the updater never makes its own');
    assert.equal(fs.existsSync(path.join(dir, '.updaterId')), false);
    blankStagingId(au, dir);   // nothing to delete: no error
    assert.equal(NIL_UUID, '00000000-0000-0000-0000-000000000000');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the updater code applies it right after setting the feed', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'updater.js'), 'utf8');
    assert.ok(src.indexOf('blankStagingId(au, userData)') > src.indexOf('au.setFeedURL('));
});
