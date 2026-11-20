#!/usr/bin/env node
// CertiFried's Discord Activity page (docs/activities.md): one bundle for the launcher, Watch Together and the
// Greenhouse frame host.
//
//   npm install --prefix frontend/activities      once, and after the dependency versions change (its own
//                                                 node_modules: never touches the bot's)
//   node frontend/activities/build.mjs           dist/manifest.json + dist/assets/app.<hash>.js|css + the Geist font
//
// dist/ is not in git (like frontend/greenhouse): build after a pull. The dashboard reads dist/manifest.json on each
// page load, so a rebuild needs no restart. The site's design tokens (--cf-*) are copied from
// dashboard/public/css/cf-ui.css at build time (frontend/greenhouse/build.mjs tokensCss), the font ships in the
// output (nothing is loaded from another host; the Activity's CSP would refuse it anyway).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokensCss, FONT_FILES } from '../greenhouse/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');
const FONTS = path.join(HERE, '../greenhouse/src/fonts');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 10);

export async function buildActivity({ outDir = path.join(HERE, 'dist'), minify = true } = {}) {
    const js = (await esbuild.build({
        entryPoints: [path.join(SRC, 'main.js')], bundle: true, write: false, format: 'iife', minify, charset: 'utf8',
        target: ['es2020', 'chrome100', 'safari15'], legalComments: 'none', logLevel: 'silent',
        nodePaths: [path.join(HERE, 'node_modules')],
    })).outputFiles[0].text;
    const font = fs.readFileSync(path.join(FONTS, FONT_FILES.sans));
    const fontName = `Geist-Variable.${hash(font)}.woff2`;
    const css = (await esbuild.build({
        stdin: { contents: tokensCss() + fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8').replaceAll('__FONT__', fontName), loader: 'css', resolveDir: SRC },
        bundle: true, write: false, minify, charset: 'utf8', external: ['*.woff2'], logLevel: 'silent',
    })).outputFiles[0].text;
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
    const names = { js: `app.${hash(js)}.js`, css: `app.${hash(css)}.css`, font: fontName };
    fs.writeFileSync(path.join(outDir, 'assets', names.js), js);
    fs.writeFileSync(path.join(outDir, 'assets', names.css), css);
    fs.writeFileSync(path.join(outDir, 'assets', fontName), font);
    fs.copyFileSync(path.join(FONTS, FONT_FILES.licence), path.join(outDir, 'assets', FONT_FILES.licence));
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ ...names, built: new Date().toISOString() }, null, 1) + '\n');
    return { outDir, ...names, jsBytes: Buffer.byteLength(js), cssBytes: Buffer.byteLength(css) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    buildActivity().then((r) => {
        console.log(`activity: ${path.relative(process.cwd(), r.outDir)}  ${r.js} ${r.jsBytes} B, ${r.css} ${r.cssBytes} B`);
    }).catch((e) => { console.error(e.message || e); process.exit(1); });
}
