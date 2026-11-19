/*
 * Guide screenshots: which manifest entries and image files a run of scripts/site-shots/run.mjs keeps (register H-752).
 *
 *   mergeManifest({ previous, written, sceneIds, only, exists })  → images[] for manifest.json
 *   strayFiles({ files, images, previous, written, only })        → file names run.mjs may delete
 *
 * Rules:
 *   - A shot taken this run replaces its old entry.
 *   - An entry marked `external: true` (an image made outside scenes.mjs, such as the CertiFried Studio screenshots
 *     studio-status and studio-hotkeys) is always kept while its file exists, and its files are never deleted.
 *   - An --only run keeps every other previous entry whose file exists, and deletes only the old files of the shots it
 *     re-took (when a re-taken shot changed its file name). It never deletes anything else.
 *   - A full run (no --only) keeps entries of scenes it did not re-take (a failed shot keeps its old image), drops
 *     entries of shots no longer in scenes.mjs unless external, and deletes .webp/.png files no kept entry owns.
 * Pure (exists is injected), tested in tests/site-shots-manifest.test.js.
 */
const filesOf = (i) => [i?.file, i?.thumb?.file].filter(Boolean);

export function mergeManifest({ previous = [], written = [], sceneIds = [], only = null, exists = () => true } = {}) {
    const scenes = new Set(sceneIds);
    const rewritten = new Set(written.map((w) => w.id));
    const present = (p) => filesOf(p).every((f) => exists(f));
    const keep = previous.filter((p) => {
        if (rewritten.has(p.id)) return false;
        if (!present(p)) return false;
        if (p.external) return true;
        if (only) return true;
        return scenes.has(p.id);
    });
    const order = (id) => { const i = sceneIds.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    return [...keep, ...written].sort((a, b) => order(a.id) - order(b.id) || String(a.id).localeCompare(String(b.id)));
}

export function strayFiles({ files = [], images = [], previous = [], written = [], only = null } = {}) {
    const owned = new Set(images.flatMap(filesOf).concat('manifest.json'));
    const isImage = (f) => /\.(webp|png)$/i.test(f);
    if (only) {
        // Only the superseded files of shots re-taken in this run.
        const rewritten = new Set(written.map((w) => w.id));
        const old = new Set(previous.filter((p) => rewritten.has(p.id)).flatMap(filesOf));
        return files.filter((f) => isImage(f) && old.has(f) && !owned.has(f));
    }
    return files.filter((f) => isImage(f) && !owned.has(f));
}

export default { mergeManifest, strayFiles };
