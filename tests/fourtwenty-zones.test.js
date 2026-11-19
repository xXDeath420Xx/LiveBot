import test from "node:test";
import assert from "node:assert/strict";
import { ZONES, snapshot } from "../utils/fourtwenty.js";

const fmts = new Map();
const offsetOf = (tz, d) => {
    if (!fmts.has(tz)) fmts.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }));
    const v = fmts.get(tz).formatToParts(d).find((p) => p.type === "timeZoneName").value;
    return v === "GMT" ? "+00:00" : v.slice(3);
};

test("every UTC offset in use worldwide has a city, every 6 hours for two years", () => {
    const world = Intl.supportedValuesOf("timeZone").filter((z) => !z.startsWith("Etc/") && !z.startsWith("Antarctica/"));
    const start = Date.UTC(new Date().getUTCFullYear(), 0, 1);
    const missing = new Map();
    for (let t = start; t < start + 2 * 366 * 864e5; t += 6 * 36e5) {
        const d = new Date(t);
        const have = new Set(ZONES.map((z) => offsetOf(z.tz, d)));
        for (const z of world) {
            const o = offsetOf(z, d);
            if (!have.has(o) && !missing.has(o)) missing.set(o, `${z} on ${d.toISOString().slice(0, 10)}`);
        }
    }
    assert.deepEqual([...missing], [], "uncovered offsets");
});

test("Darwin is tracked and lights at 4:20 local", () => {
    assert.ok(ZONES.some((z) => z.tz === "Australia/Darwin"));
    // 2026-11-08 06:50 UTC = 16:20 in Darwin (UTC+9:30, no DST)
    const s = snapshot(Date.UTC(2026, 10, 8, 6, 50, 10));
    assert.ok(s.lit.some((l) => l.zone.tz === "Australia/Darwin" && l.ap === "PM"));
});

test("no duplicate time zones, all valid", () => {
    assert.equal(new Set(ZONES.map((z) => z.tz)).size, ZONES.length);
    for (const z of ZONES) assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: z.tz }));
});
