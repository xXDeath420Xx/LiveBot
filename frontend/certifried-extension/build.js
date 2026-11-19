#!/usr/bin/env node
/**
 * CertiFried Extension - Build Script
 *
 *   node build.js               website bundle -> dist/ (served by the game server at /game,
 *                               reached through the dashboard proxy at /game and /cfx/dist)
 *   node build.js --production  same, minified
 *   node build.js --twitch      Twitch panel package -> services/certifried-extension/twitch-extension/panel/
 *                               (zip-ready: panel.html, panel.js, panel.css, app.js, main.css, no
 *                               remote scripts except the Twitch helper) and a .zip next to it
 *   node build.js --watch       rebuild dist/ on change
 *
 * The panel calls the game server at CFX_PANEL_EBS_URL (default https://certifriedmultitool.com/cfx,
 * the dashboard proxy). This is NOT CFX_EBS_URL, which the server uses as its site address for
 * OAuth redirects.
 */

import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, 'src');
const DIST_DIR = path.join(__dirname, 'dist');
const PANEL_DIR = path.resolve(__dirname, '../../services/certifried-extension/twitch-extension/panel');

const args = process.argv.slice(2);
const isWatch = args.includes('--watch') || args.includes('-w');
const isProduction = args.includes('--production') || args.includes('-p');
const isTwitch = args.includes('--twitch');

const config = {
    ebsUrl: process.env.CFX_PANEL_EBS_URL || 'https://certifriedmultitool.com/cfx-api',
    clientId: process.env.TWITCH_EXTENSION_CLIENT_ID || ''
};

const defines = (production) => ({
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
    '__EBS_URL__': JSON.stringify(config.ebsUrl),
    '__CLIENT_ID__': JSON.stringify(config.clientId)
});

async function buildJS(outfile, { minify, sourcemap }) {
    await esbuild.build({
        entryPoints: [path.join(SRC_DIR, 'index.js')],
        bundle: true,
        outfile,
        format: 'esm',
        target: ['es2020', 'chrome90', 'firefox88', 'safari14'],
        minify,
        sourcemap,
        define: defines(minify),
        treeShaking: true,
        legalComments: 'none'
    });
    console.log(`  ${path.basename(outfile)}: ${(fs.statSync(outfile).size / 1024).toFixed(1)} KB`);
}

async function buildCSS(outfile, { minify, sourcemap }) {
    await esbuild.build({
        entryPoints: [path.join(SRC_DIR, 'styles', 'main.css')],
        bundle: true,
        outfile,
        minify,
        sourcemap,
        loader: { '.css': 'css' }
    });
    console.log(`  ${path.basename(outfile)}: ${(fs.statSync(outfile).size / 1024).toFixed(1)} KB`);
}

/** Website: standalone.html goes into dist/ as-is (it finds its own asset base at runtime). */
function copyWebAssets() {
    fs.copyFileSync(path.join(__dirname, 'standalone.html'), path.join(DIST_DIR, 'standalone.html'));
    const logoSrc = path.join(__dirname, '../../dashboard/public/images/CertiFried.png');
    if (fs.existsSync(logoSrc)) fs.copyFileSync(logoSrc, path.join(DIST_DIR, 'CertiFried.png'));
    console.log('  standalone.html, CertiFried.png');
}

/** Twitch panel: everything the zip needs, flat, relative paths only. */
async function buildTwitch() {
    fs.rmSync(PANEL_DIR, { recursive: true, force: true });
    fs.mkdirSync(PANEL_DIR, { recursive: true });
    await Promise.all([
        buildJS(path.join(PANEL_DIR, 'app.js'), { minify: true, sourcemap: false }),
        buildCSS(path.join(PANEL_DIR, 'main.css'), { minify: true, sourcemap: false })
    ]);
    for (const f of ['panel.html', 'panel.js', 'panel.css', 'config.html']) {
        fs.copyFileSync(path.join(__dirname, 'twitch', f), path.join(PANEL_DIR, f));
    }

    // Guard the Twitch rules this package must keep
    for (const page of ['panel.html', 'config.html']) {
        const html = fs.readFileSync(path.join(PANEL_DIR, page), 'utf8');
        const remote = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).filter(u => /^https?:/.test(u));
        if (remote.some(u => u !== 'https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js')) {
            throw new Error(`${page} loads a remote script other than the Twitch helper: ${remote.join(', ')}`);
        }
        if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error(`${page} has an inline script`);
        if (/(href|src)="\//.test(html)) throw new Error(`${page} uses an absolute asset path`);
        }

    const files = fs.readdirSync(PANEL_DIR).sort();
    const hash = crypto.createHash('sha256');
    for (const f of files) hash.update(f).update(fs.readFileSync(path.join(PANEL_DIR, f)));
    const version = hash.digest('hex').slice(0, 10);
    fs.writeFileSync(path.join(PANEL_DIR, '..', 'BUILD.txt'),
        `Built ${new Date().toISOString()}\nEBS (API base baked into app.js): ${config.ebsUrl}\nFiles: ${files.join(', ')}\nContent hash: ${version}\n`);

    const zipPath = path.join(PANEL_DIR, '..', 'certifried-panel.zip');
    fs.rmSync(zipPath, { force: true });
    try {
        execFileSync('zip', ['-q', '-X', '-j', zipPath, ...files.map(f => path.join(PANEL_DIR, f))]);
        console.log(`  zip: ${zipPath} (${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB)`);
    } catch (error) {
        console.log('  zip not created (is the "zip" command installed?); the panel/ folder is ready to zip by hand');
    }
}

async function watch() {
    const jsContext = await esbuild.context({
        entryPoints: [path.join(SRC_DIR, 'index.js')],
        bundle: true,
        outfile: path.join(DIST_DIR, 'app.js'),
        format: 'esm',
        target: ['es2020'],
        sourcemap: true,
        define: defines(false)
    });
    const cssContext = await esbuild.context({
        entryPoints: [path.join(SRC_DIR, 'styles', 'main.css')],
        bundle: true,
        outfile: path.join(DIST_DIR, 'main.css'),
        loader: { '.css': 'css' }
    });
    await jsContext.watch();
    await cssContext.watch();
    console.log('Watching for changes...');
}

async function build() {
    console.log(`\nCertiFried Extension Build (${isTwitch ? 'Twitch panel' : isProduction ? 'website, production' : 'website, development'})`);
    console.log(`Panel EBS: ${config.ebsUrl}\n`);
    const start = Date.now();
    try {
        if (isTwitch) {
            await buildTwitch();
        } else {
            fs.mkdirSync(DIST_DIR, { recursive: true });
            await Promise.all([
                buildJS(path.join(DIST_DIR, 'app.js'), { minify: isProduction, sourcemap: !isProduction }),
                buildCSS(path.join(DIST_DIR, 'main.css'), { minify: isProduction, sourcemap: !isProduction })
            ]);
            copyWebAssets();
        }
        console.log(`\nBuild complete in ${Date.now() - start}ms\n`);
    } catch (error) {
        console.error('\nBuild failed:', error);
        process.exit(1);
    }
}

if (isWatch) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    copyWebAssets();
    watch();
} else {
    build();
}
