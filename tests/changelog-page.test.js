import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChangelog, plainText, USER_NOTES, FIRST_RECORDED } from "../dashboard/services/changelog.js";

/*
 * /changelog is built from migration headers (dashboard/services/changelog.js). Recent migrations have
 * notes written for users; other headers lose references only the team can follow; a migration that is
 * not recorded as run (from 417 on) is left off.
 */
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const JARGON = /\bH-\d+|\bregister\b|\bcfx\b|[a-z]+_[a-z_]+|\.js\b|\bdocs\//i;

test("plainText drops register, owner and file references and keeps the rest", () => {
    assert.equal(plainText("suggestions wait for staff (register H-662)."), "suggestions wait for staff.");
    assert.equal(plainText("permanent tracking (owner request 2026-11-18: \"more than 7 days\")."), "permanent tracking.");
    assert.equal(plainText("daily digest (jobs/health-digest.js)."), "daily digest.");
    assert.equal(plainText("kept for 30 days (configurable)."), "kept for 30 days (configurable).");
});

test("every note reads as plain text for users", () => {
    for (const id of [437, 438, 439, 440, 441, 442, 443, 444, 445, 446, 447, 448, 449]) {
        const n = USER_NOTES[id];
        assert.ok(n && n.title && n.desc, `note for ${id}`);
        assert.doesNotMatch(`${n.title} ${n.desc}`, JARGON, `note ${id}`);
    }
});

test("notes replace the header; unrecorded migrations from 417 on are left off", async () => {
    const all = await buildChangelog(dir);
    const e449 = all.find(e => e.id === 449);
    assert.equal(e449.title, USER_NOTES[449].title);
    assert.match(e449.date, /^\d{4}-\d{2}-\d{2}$/);
    const recorded = new Set(["449_moderation_ticket_retention.js"]);
    const shown = await buildChangelog(dir, { recorded });
    assert.ok(shown.some(e => e.id === 449));
    assert.ok(!shown.some(e => e.id >= FIRST_RECORDED && e.id !== 449), "only recorded ones from 417");
    assert.ok(shown.some(e => e.id === FIRST_RECORDED - 1), "older ones are all shown");
    for (const e of all) assert.doesNotMatch(e.desc, /\(register H-\d+/, `#${e.id}`);
});
