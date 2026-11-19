#!/usr/bin/env node
/**
 * Make the running dashboard pick up changed templates (dashboard/views) and static files
 * (dashboard/public) WITHOUT restarting CertiFriedUtility (which would drop every bot).
 *
 *   node scripts/reload-dashboard.mjs [--reason "text"] [--timeout 20] [--verify URL]
 *
 * Writes the request file the dashboard watches (dashboard/services/dashboard-reload.js) and
 * waits for the server's acknowledgement carrying the same id. With --verify it then GETs the
 * URL and requires a 200. Exit 0 = reloaded (and verified); 1 = the server reported an error or
 * the URL failed; 2 = no acknowledgement in time (dashboard down, or running code from before
 * this mechanism existed — then only a restart applies the change).
 *
 * Changes to .js files (routes, core/, services/) are NOT applied by this; they need a restart.
 */
import fs from 'node:fs';
import { REQUEST_FILE, ACK_FILE, makeRequest, writeJsonAtomic } from '../dashboard/services/dashboard-reload.js';

function arg(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const reason = arg('reason', 'manual reload');
const timeoutMs = Math.max(2, Number(arg('timeout', 20)) || 20) * 1000;
const verifyUrl = arg('verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const request = makeRequest(reason);
writeJsonAtomic(REQUEST_FILE, request);
console.log(`reload requested (${request.id}): ${request.reason}`);

let ack = null;
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
    try {
        const body = JSON.parse(fs.readFileSync(ACK_FILE, 'utf8'));
        if (body?.id === request.id) { ack = body; break; }
    } catch { /* not written yet */ }
    await sleep(200);
}
if (!ack) {
    console.error(`no acknowledgement within ${timeoutMs / 1000}s: is the dashboard running code that has dashboard-reload.js? (a restart applies the change otherwise)`);
    process.exit(2);
}
if (!ack.ok) {
    console.error(`the dashboard reported a reload error: ${ack.error}`);
    process.exit(1);
}
console.log(`reloaded: generation ${ack.generation}, ${ack.cleared} compiled template(s) dropped`);

if (verifyUrl) {
    try {
        const res = await fetch(verifyUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
        if (res.status !== 200) {
            console.error(`verify: ${verifyUrl} answered ${res.status}`);
            process.exit(1);
        }
        console.log(`verify: ${verifyUrl} answered 200`);
    } catch (error) {
        console.error(`verify: ${verifyUrl} failed: ${error.message}`);
        process.exit(1);
    }
}
process.exit(0);
