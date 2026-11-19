/*
 * Import this FIRST in a test file (`import './fixtures/test-log-dir.js';`), before anything that loads utils/logger.js.
 *
 * utils/logger.js reads process.env.LOG_DIR when it is first imported, and ESM imports run before the test body, so
 * setting LOG_DIR inside a test is too late: test runs then wrote "[StreamBotLink] sign-in approved …" into the live
 * logs/combined-*.log. This module runs first and points every log at a fresh temp folder (removed at exit):
 *   LOG_DIR                  always a new temp folder, unless TEST_LOG_DIR names one to use instead
 *   MUSIC_HEALTH_DATA_DIR    a temp folder too, unless it already points inside the system temp folder
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = [];
const tmpRoot = path.resolve(os.tmpdir());
const insideTmp = (p) => !!p && path.resolve(p).startsWith(tmpRoot + path.sep);

if (process.env.TEST_LOG_DIR) {
    process.env.LOG_DIR = process.env.TEST_LOG_DIR;
} else {
    process.env.LOG_DIR = fs.mkdtempSync(path.join(tmpRoot, 'sbt-logs-'));
    made.push(process.env.LOG_DIR);
}
if (!insideTmp(process.env.MUSIC_HEALTH_DATA_DIR)) {
    process.env.MUSIC_HEALTH_DATA_DIR = fs.mkdtempSync(path.join(tmpRoot, 'sbt-music-'));
    made.push(process.env.MUSIC_HEALTH_DATA_DIR);
}

process.on('exit', () => {
    for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

export const TEST_LOG_DIR = process.env.LOG_DIR;
export default TEST_LOG_DIR;
