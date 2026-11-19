import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBackupFilename, backupReason, normaliseKind } from '../dashboard/services/windrose-backup-meta.js';

// Windrose backup ledger: kind/label/reason from what the agent reports (dashboard/services/windrose-backup-meta.js)


test('windrose backup filenames give kind and label', () => {
    const w = '5A93CB6B298040910A84D5A2C2EF6285_0.10.0_20260808-234544';
    assert.deepEqual(parseBackupFilename(`${w}_manual.zip`), { kind: 'manual', label: null });
    assert.deepEqual(parseBackupFilename(`${w}_manual_preupdate.zip`), { kind: 'manual', label: 'preupdate' });
    assert.deepEqual(parseBackupFilename(`${w}_pre-restore_preimport.zip`), { kind: 'pre-restore', label: 'preimport' });
    assert.deepEqual(parseBackupFilename(`${w}_scheduled.zip`), { kind: 'scheduled', label: null });
    assert.deepEqual(parseBackupFilename('uploaded-world.zip'), { kind: null, label: null });
});

test('windrose backup reasons read like the panel needs them', () => {
    assert.equal(backupReason({ kind: 'manual', label: null }), 'Manual snapshot');
    assert.equal(backupReason({ kind: 'manual', label: 'preupdate' }), 'Before a server image update');
    assert.equal(backupReason({ kind: 'scheduled', label: null }), 'Scheduled restart');
    assert.equal(backupReason({ kind: 'pre-restore', label: null }), 'Before a restore');
    assert.equal(backupReason({ kind: 'manual', label: 'beforeboss' }), 'beforeboss');
    assert.equal(normaliseKind('weird'), null);
});
