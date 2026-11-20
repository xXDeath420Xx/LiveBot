/*
 * Screenshots for the guides added on 2026-11-20: one module per guide in this folder, loaded in name
 * order by scenes.mjs. Each module default-exports
 *
 *     async ({ manage, page, discord, image, ctx, demo }) => { ... }
 *
 * and uses the same shot builders as scenes.mjs (shots.mjs). Shot ids start with the guide's slug.
 * Maple Hollow data only (demo-data.mjs): anything a module adds, such as an extra channel or a member's
 * message, is invented and uses the obviously fake id ranges.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function guideScenes(args) {
    const files = fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs').sort();
    for (const f of files) {
        // One broken module must not take every other screenshot with it: its shots are missing (and an
        // --only run naming them fails with "unknown shot id"), the rest still run.
        try {
            const mod = await import(pathToFileURL(path.join(HERE, f)).href);
            await mod.default(args);
        } catch (error) {
            console.warn(`  guide-scenes/${f}: ${error.message}`);
        }
    }
}
