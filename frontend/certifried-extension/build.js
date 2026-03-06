#!/usr/bin/env node
/**
 * CertiFried Extension - Build Script
 * Bundles frontend for Twitch Extension and standalone deployment
 */

import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, 'src');
const DIST_DIR = path.join(__dirname, 'dist');
const RELEASE_DIR = path.join(__dirname, 'release');

// Parse CLI args
const args = process.argv.slice(2);
const isWatch = args.includes('--watch') || args.includes('-w');
const isProduction = args.includes('--production') || args.includes('-p');
const shouldZip = args.includes('--zip') || args.includes('-z');

// Configuration
const config = {
    // EBS URL - set from environment or default
    ebsUrl: process.env.CFX_EBS_URL || 'https://certifriedmultitool.com/cfx-api',
    // Extension client ID
    clientId: process.env.TWITCH_EXTENSION_CLIENT_ID || ''
};

/**
 * Build JavaScript bundle
 */
async function buildJS() {
    const outfile = path.join(DIST_DIR, 'app.js');

    const result = await esbuild.build({
        entryPoints: [path.join(SRC_DIR, 'index.js')],
        bundle: true,
        outfile,
        format: 'esm',
        target: ['es2020', 'chrome90', 'firefox88', 'safari14'],
        minify: isProduction,
        sourcemap: !isProduction,
        define: {
            'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
            '__EBS_URL__': JSON.stringify(config.ebsUrl),
            '__CLIENT_ID__': JSON.stringify(config.clientId)
        },
        metafile: true,
        treeShaking: true,
        legalComments: 'none'
    });

    // Report bundle size
    const stats = fs.statSync(outfile);
    const sizeKB = (stats.size / 1024).toFixed(2);
    console.log(`  app.js: ${sizeKB} KB`);

    if (result.metafile && isProduction) {
        // Analyze bundle if over 500KB
        if (stats.size > 500 * 1024) {
            console.log('  Warning: Bundle is large. Run with --analyze for details.');
        }
    }

    return result;
}

/**
 * Build CSS bundle
 */
async function buildCSS() {
    const outfile = path.join(DIST_DIR, 'main.css');

    await esbuild.build({
        entryPoints: [path.join(SRC_DIR, 'styles', 'main.css')],
        bundle: true,
        outfile,
        minify: isProduction,
        sourcemap: !isProduction,
        loader: { '.css': 'css' }
    });

    const stats = fs.statSync(outfile);
    const sizeKB = (stats.size / 1024).toFixed(2);
    console.log(`  main.css: ${sizeKB} KB`);
}

/**
 * Copy static assets
 */
function copyAssets() {
    // Generate cache-busting version based on timestamp
    const buildVersion = Date.now().toString(36);

    // Copy HTML files
    const htmlFiles = ['panel.html', 'standalone.html'];

    for (const file of htmlFiles) {
        const src = path.join(__dirname, file);
        const dest = path.join(DIST_DIR, file);

        if (fs.existsSync(src)) {
            let content = fs.readFileSync(src, 'utf8');

            // Replace dev paths with production paths
            if (isProduction) {
                content = content
                    .replace(/\.\/dist\//g, './')
                    .replace(/src="\.\/src\//g, 'src="./')
                    .replace('type="module"', ''); // For broader compatibility
            }

            // Add cache-busting query parameters to JS and CSS references
            content = content
                .replace(/(app\.js)(\?v=[a-z0-9]+)?"/g, `$1?v=${buildVersion}"`)
                .replace(/(main\.css)(\?v=[a-z0-9]+)?"/g, `$1?v=${buildVersion}"`);

            fs.writeFileSync(dest, content);
        }
    }

    // Copy logo from dashboard assets
    const logoSrc = path.join(__dirname, '../../dashboard/public/images/CertiFried.png');
    const logoDest = path.join(DIST_DIR, 'CertiFried.png');
    if (fs.existsSync(logoSrc)) {
        fs.copyFileSync(logoSrc, logoDest);
        console.log('  Copied CertiFried.png');
    }

    console.log('  Copied HTML files');
    console.log(`  Cache version: ${buildVersion}`);
}

/**
 * Create Twitch Extension zip package
 */
function createZip() {
    const zipName = `certifried-extension-${Date.now()}.zip`;
    const zipPath = path.join(RELEASE_DIR, zipName);

    // Create release directory
    if (!fs.existsSync(RELEASE_DIR)) {
        fs.mkdirSync(RELEASE_DIR, { recursive: true });
    }

    // Files to include
    const files = [
        'panel.html',
        'app.js',
        'main.css'
    ];

    // Use execFileSync for safer execution (no shell injection risk)
    try {
        execFileSync('zip', ['-r', zipPath, ...files], {
            cwd: DIST_DIR,
            stdio: 'inherit'
        });
        console.log(`\n  Created: ${zipPath}`);

        // Check size (Twitch limit is ~1MB for panel)
        const stats = fs.statSync(zipPath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`  Size: ${sizeMB} MB`);

        if (stats.size > 1024 * 1024) {
            console.log('  Warning: Package exceeds 1MB. May need optimization.');
        }

    } catch (error) {
        console.error('  Failed to create zip:', error.message);
        console.log('  Make sure "zip" command is available on your system.');
    }
}

/**
 * Watch mode
 */
async function watch() {
    // Create esbuild contexts for watch mode
    const jsContext = await esbuild.context({
        entryPoints: [path.join(SRC_DIR, 'index.js')],
        bundle: true,
        outfile: path.join(DIST_DIR, 'app.js'),
        format: 'esm',
        target: ['es2020'],
        sourcemap: true,
        define: {
            'process.env.NODE_ENV': '"development"',
            '__EBS_URL__': JSON.stringify(config.ebsUrl),
            '__CLIENT_ID__': JSON.stringify(config.clientId)
        }
    });

    const cssContext = await esbuild.context({
        entryPoints: [path.join(SRC_DIR, 'styles', 'main.css')],
        bundle: true,
        outfile: path.join(DIST_DIR, 'main.css'),
        loader: { '.css': 'css' }
    });

    // Start watching
    await jsContext.watch();
    await cssContext.watch();

    console.log('Watching for changes...');
}

/**
 * Main build function
 */
async function build() {
    console.log(`\nCertiFried Extension Build`);
    console.log(`Mode: ${isProduction ? 'production' : 'development'}`);
    console.log(`EBS: ${config.ebsUrl}\n`);

    // Create dist directory
    if (!fs.existsSync(DIST_DIR)) {
        fs.mkdirSync(DIST_DIR, { recursive: true });
    }

    const start = Date.now();

    try {
        console.log('Building...');

        await Promise.all([
            buildJS(),
            buildCSS()
        ]);

        copyAssets();

        if (shouldZip) {
            createZip();
        }

        const duration = Date.now() - start;
        console.log(`\nBuild complete in ${duration}ms\n`);

    } catch (error) {
        console.error('\nBuild failed:', error);
        process.exit(1);
    }
}

// Run
if (isWatch) {
    // Ensure dist exists
    if (!fs.existsSync(DIST_DIR)) {
        fs.mkdirSync(DIST_DIR, { recursive: true });
    }
    copyAssets();
    watch();
} else {
    build();
}
