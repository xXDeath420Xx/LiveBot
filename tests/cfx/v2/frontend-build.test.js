// Greenhouse Tycoon (phase 3): the build and the Twitch panel package rules (audit B7 point 4, B8 row 3).
//   - the zip holds exactly the five panel files; panel.html loads the Twitch helper first and no other remote
//     script; no inline script, inline handler, inline style or absolute path; config.html says there is
//     nothing to set up and does not use the panel's stylesheet
//   - panel.js is readable (not minified), within the 120 KB budget, with no dynamic code or HTML sinks and
//     only listed URLs; panel.css within 25 KB
//   - each rule is shown to catch a broken package (the checker is not a no-op)
//   - the website build: hashed assets, no inline script; the site's tokens are copied in
//   - the source never writes HTML from strings
//   - phase 4: Geist ships in both outputs with its SIL OFL 1.1 licence; no font host anywhere; the raised
//     budgets (JS 170 KB, CSS 32 KB, font 100 KB)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWeb, buildPanel, checkPanel, tokensCss, PANEL_FILES, BUDGET, HELPER_URL, FONT_FILES } from '../../../frontend/greenhouse/build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
let tmp;
let panel;
let web;

before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh3-buildtest-'));
    panel = await buildPanel({ outDir: path.join(tmp, 'panel'), zipPath: path.join(tmp, 'greenhouse-panel.zip') });
    web = await buildWeb({ outDir: path.join(tmp, 'web') });
});

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

function copyPanel(name) {
    const dir = path.join(tmp, name);
    fs.cpSync(panel.outDir, dir, { recursive: true });
    return dir;
}

describe('Twitch panel package', () => {
    test('the built package passes every rule', () => {
        assert.deepEqual(checkPanel(panel.outDir), []);
    });

    test('the zip holds exactly the panel files', () => {
        assert.ok(PANEL_FILES.includes(FONT_FILES.sans) && PANEL_FILES.includes(FONT_FILES.licence), 'the font and its licence are in the package');
        const list = execFileSync('unzip', ['-Z1', panel.zipPath], { encoding: 'utf8' }).trim().split('\n').sort();
        assert.deepEqual(list, [...PANEL_FILES]);
        assert.ok(panel.zipBytes < 200 * 1024, `zip is ${panel.zipBytes} B`);
        const sizes = PANEL_FILES.map(f => `${f} ${panel.sizes[f]} B`).join(', ');
        console.log(`# panel zip ${panel.zipBytes} B (${sizes})`);
    });

    test('panel.html: helper first, then only local files', () => {
        const html = fs.readFileSync(path.join(panel.outDir, 'panel.html'), 'utf8');
        const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(m => m[1]);
        assert.deepEqual(scripts, [HELPER_URL, 'panel.js']);
        assert.ok(html.indexOf(HELPER_URL) < html.indexOf('panel.css'));
    });

    test('panel.js is readable and within budget', () => {
        const js = fs.readFileSync(path.join(panel.outDir, 'panel.js'), 'utf8');
        const lines = js.split('\n');
        assert.ok(lines.length > 800, `${lines.length} lines`);
        assert.ok(Buffer.byteLength(js) <= BUDGET.jsBytes, `${Buffer.byteLength(js)} B`);
        for (const name of ['function plantSvg', 'function createApi', 'function createSession', 'function createSync', 'function connectTwitch']) assert.ok(js.includes(name), name);
    });

    test('each rule catches a broken package', () => {
        const cases = [
            ['inline script', (d) => fs.appendFileSync(path.join(d, 'panel.html'), '<script>window.x = 1</script>\n'), /inline script|inline code/],
            ['remote script', (d) => fs.appendFileSync(path.join(d, 'panel.html'), '<script src="https://cdn.example.com/x.js"></script>\n'), /remote script/],
            ['helper not first', (d) => {
                const f = path.join(d, 'panel.html');
                fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<script src="first.js"></script>'));
            }, /helper must be the first script/],
            ['absolute path', (d) => {
                const f = path.join(d, 'panel.html');
                fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('href="panel.css"', 'href="/panel.css"'));
            }, /absolute asset path/],
            ['inline handler', (d) => {
                const f = path.join(d, 'panel.html');
                fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('<body>', '<body onload="go()">'));
            }, /inline event handler/],
            ['minified js', (d) => {
                const f = path.join(d, 'panel.js');
                fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n\s*/g, ' '));
            }, /looks minified/],
            ['unlisted URL', (d) => fs.appendFileSync(path.join(d, 'panel.js'), '\nfetch("https://tracker.example.com/x");\n'), /unlisted URL/],
            ['HTML sink', (d) => fs.appendFileSync(path.join(d, 'panel.js'), '\ndocument.body.inner' + 'HTML = "x";\n'), /panel\.js uses/],
            ['extra file', (d) => fs.writeFileSync(path.join(d, 'notes.txt'), 'x'), /files must be exactly/],
            ['config uses panel.css', (d) => {
                const f = path.join(d, 'config.html');
                fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('config.css', 'panel.css'));
            }, /must not use panel\.css/],
            ['a Google Fonts stylesheet', (d) => {
                const f = path.join(d, 'panel.html');
                fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('<link rel="stylesheet" href="panel.css">', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist">\n<link rel="stylesheet" href="panel.css">'));
            }, /remote stylesheet|font host/],
            ['the font file missing', (d) => fs.rmSync(path.join(d, 'Geist-Variable.woff2')), /not in the package|files must be exactly/],
            ['the licence text missing', (d) => fs.writeFileSync(path.join(d, 'Geist-OFL.txt'), 'all rights reserved'), /Open Font License/],
            ['a font that is not woff2', (d) => fs.writeFileSync(path.join(d, 'Geist-Variable.woff2'), 'not a font'), /not a woff2 file/],
            ['config without the setup sentence', (d) => {
                const f = path.join(d, 'config.html');
                fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/nothing to set up/gi, 'settings'));
            }, /nothing to set up/]
        ];
        for (const [label, breakIt, expect] of cases) {
            const dir = copyPanel(`broken-${label.replace(/\W+/g, '-')}`);
            breakIt(dir);
            const problems = checkPanel(dir);
            assert.ok(problems.some(p => expect.test(p)), `${label}: ${JSON.stringify(problems)}`);
        }
    });
});

describe('fonts (phase 3 follow-up, owner decision: Geist ships with the game)', () => {
    test('the panel package carries Geist and the SIL OFL 1.1 text; its stylesheet uses the local file', () => {
        const css = fs.readFileSync(path.join(panel.outDir, 'panel.css'), 'utf8');
        assert.match(css, /@font-face\s*{[^}]*font-family:\s*['"]Geist['"][^}]*url\(["']?\.\/Geist-Variable\.woff2["']?\)/);
        const font = fs.readFileSync(path.join(panel.outDir, FONT_FILES.sans));
        assert.equal(font.subarray(0, 4).toString('latin1'), 'wOF2');
        assert.ok(font.length <= BUDGET.fontBytes, `${font.length} B`);
        const licence = fs.readFileSync(path.join(panel.outDir, FONT_FILES.licence), 'utf8');
        assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/);
        assert.match(licence, /Copyright \(c\) 2023 Vercel/);
        assert.ok(!/@font-face\s*{[^}]*Geist ?Mono/.test(css) && !css.includes('GeistMono-Variable'), 'the panel ships no monospaced font (link codes are website-only)');
    });

    test('no font host anywhere in either build', () => {
        const texts = [];
        for (const f of ['panel.html', 'config.html', 'panel.css', 'panel.js']) texts.push([`panel/${f}`, fs.readFileSync(path.join(panel.outDir, f), 'utf8')]);
        texts.push(['web/index.html', fs.readFileSync(path.join(web.outDir, 'index.html'), 'utf8')]);
        for (const f of fs.readdirSync(path.join(web.outDir, 'assets')).filter(x => /\.(css|js)$/.test(x))) texts.push([f, fs.readFileSync(path.join(web.outDir, 'assets', f), 'utf8')]);
        for (const [name, text] of texts) assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(text), `${name} refers to a font host`);
        const fe = fs.readFileSync(path.join(repo, 'frontend/greenhouse/src/web.html'), 'utf8') + fs.readFileSync(path.join(repo, 'frontend/greenhouse/src/panel.html'), 'utf8');
        assert.ok(!/googleapis|gstatic/.test(fe), 'the HTML sources link no font host');
    });

    test('the website ships hashed Geist and Geist Mono and the licence; the stylesheet and preload use those names', () => {
        const files = fs.readdirSync(path.join(web.outDir, 'assets'));
        const sans = files.find(f => /^Geist-Variable\.[0-9a-f]{10}\.woff2$/.test(f));
        const mono = files.find(f => /^GeistMono-Variable\.[0-9a-f]{10}\.woff2$/.test(f));
        assert.ok(sans && mono, files.join(', '));
        assert.ok(files.includes(FONT_FILES.licence));
        const css = fs.readFileSync(path.join(web.outDir, 'assets', files.find(f => /^app\.[0-9a-f]{10}\.css$/.test(f))), 'utf8');
        assert.ok(css.includes(sans) && css.includes(mono), 'the stylesheet names the hashed fonts');
        const html = fs.readFileSync(path.join(web.outDir, 'index.html'), 'utf8');
        assert.ok(html.includes(`/greenhouse/assets/${sans}`), 'the page preloads the hashed font');
    });

    test('budgets: JS 170 KB, CSS 32 KB (raised in phase 4), font 100 KB', () => {
        assert.deepEqual({ ...BUDGET }, { jsBytes: 170 * 1024, cssBytes: 32 * 1024, fontBytes: 100 * 1024 });
        const cssBytes = fs.statSync(path.join(panel.outDir, 'panel.css')).size;
        assert.ok(cssBytes <= BUDGET.cssBytes, `${cssBytes} B`);
        console.log(`# panel.js ${panel.sizes['panel.js']} B of ${BUDGET.jsBytes}, panel.css ${cssBytes} B of ${BUDGET.cssBytes}`);
    });
});

describe('website build', () => {
    test('hashed assets, no inline script, the site tokens', () => {
        const html = fs.readFileSync(path.join(web.outDir, 'index.html'), 'utf8');
        assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline script');
        assert.match(html, /src="\/greenhouse\/assets\/app\.[0-9a-f]{10}\.js"/);
        assert.match(html, /href="\/greenhouse\/assets\/app\.[0-9a-f]{10}\.css"/);
        const files = fs.readdirSync(path.join(web.outDir, 'assets'));
        assert.equal(files.filter(f => f.endsWith('.map')).length, 0, 'no source maps');
        assert.ok(web.jsBytes < BUDGET.jsBytes, `${web.jsBytes} B`);
        const tokens = tokensCss();
        assert.match(tokens, /--cf-accent: #b4e04f;/);
        assert.match(tokens, /--cf-text-3: #8a8c95;/);
        assert.match(tokens, /:root\[data-theme="light"\]/);
    });

    test('the source never builds HTML from strings and never uses native dialogs', () => {
        const hits = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (e.name.endsWith('.js')) {
                    const text = fs.readFileSync(full, 'utf8');
                    const re = new RegExp(['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'document\\.wr' + 'ite', '\\balert\\(', 'window\\.confirm\\('].join('|'));
                    if (re.test(text)) hits.push(path.relative(repo, full));
                }
            }
        };
        walk(path.join(repo, 'frontend/greenhouse/src'));
        assert.deepEqual(hits, []);
    });
});
