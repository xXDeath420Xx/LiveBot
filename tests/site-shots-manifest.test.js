import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeManifest, strayFiles } from '../scripts/site-shots/manifest.mjs';

/*
 * Guide screenshots (scripts/site-shots/run.mjs, register H-752): a run never deletes images made outside scenes.mjs
 * (marked `external`, such as the CertiFried Studio shots), and an --only run deletes nothing but the old files of the
 * shots it re-took. Also: the live manifest marks the Studio shots external, and every manifest file is on disk.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = (id, extra = {}) => ({ id, file: `${id}.webp`, thumb: { file: `${id}.thumb.webp` }, ...extra });
const previous = [entry('overview'), entry('editor'), entry('studio-status', { external: true }), entry('gone-scene')];
const files = ['overview.webp', 'overview.thumb.webp', 'editor.webp', 'editor.thumb.webp', 'studio-status.webp', 'studio-status.thumb.webp',
    'gone-scene.webp', 'gone-scene.thumb.webp', 'stray.png', 'manifest.json', 'notes.txt'];
const sceneIds = ['overview', 'editor'];

test('an --only run keeps everything it did not re-take and deletes nothing it did not replace', () => {
    const written = [entry('editor')];
    const images = mergeManifest({ previous, written, sceneIds, only: ['editor'] });
    assert.deepEqual(images.map((i) => i.id).sort(), ['editor', 'gone-scene', 'overview', 'studio-status']);
    assert.deepEqual(strayFiles({ files, images, previous, written, only: ['editor'] }), [], 'same file names: nothing to delete');
    // a re-taken shot that changed its file name loses only its own old files
    const renamed = [{ id: 'editor', file: 'editor-v2.webp', thumb: { file: 'editor-v2.thumb.webp' } }];
    const images2 = mergeManifest({ previous, written: renamed, sceneIds, only: ['editor'] });
    assert.deepEqual(strayFiles({ files, images: images2, previous, written: renamed, only: ['editor'] }).sort(), ['editor.thumb.webp', 'editor.webp']);
});

test('a full run drops shots no longer in scenes.mjs but never external images', () => {
    const written = [entry('overview'), entry('editor')];
    const images = mergeManifest({ previous, written, sceneIds, only: null });
    assert.deepEqual(images.map((i) => i.id), ['overview', 'editor', 'studio-status']);
    assert.deepEqual(strayFiles({ files, images, previous, written, only: null }).sort(), ['gone-scene.thumb.webp', 'gone-scene.webp', 'stray.png']);
    // a scene whose shot failed this run keeps its previous image
    const partial = mergeManifest({ previous, written: [entry('overview')], sceneIds, only: null });
    assert.ok(partial.some((i) => i.id === 'editor'));
    // an external entry whose file went missing is dropped (the manifest must not point at nothing)
    const missing = mergeManifest({ previous, written, sceneIds, exists: (f) => !f.startsWith('studio-status') });
    assert.equal(missing.some((i) => i.id === 'studio-status'), false);
});

test('the live manifest marks the Studio shots external and every file in it is on disk', () => {
    const dir = path.join(root, 'dashboard/public/img/guides');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    for (const id of ['studio-status', 'studio-hotkeys']) {
        const im = m.images.find((i) => i.id === id);
        assert.ok(im, `${id} is in the manifest`);
        assert.equal(im.external, true, `${id} is marked external`);
    }
    for (const im of m.images) for (const f of [im.file, im.thumb?.file].filter(Boolean)) assert.ok(fs.existsSync(path.join(dir, f)), `${f} exists`);
    const run = fs.readFileSync(path.join(root, 'scripts/site-shots/run.mjs'), 'utf8');
    assert.match(run, /mergeManifest\(/);
    assert.match(run, /strayFiles\(/);
    assert.doesNotMatch(run, /if \(!owned\.has\(f\) && \/\\\.\(webp\|png\)\$\/\.test\(f\)\) fs\.rmSync/, 'the old delete-everything-unowned loop is gone');
});
