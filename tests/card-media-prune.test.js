import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * The privacy policy says greeting-card voice notes, AI covers and imported pages are deleted with their
 * signature or card. jobs/retention-sweeper.js pruneCardMediaFiles removes the files nothing points at.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "card-media-"));
process.env.LOG_DIR = tmp;
const { pruneCardMediaFiles, uploadNamesIn } = await import("../jobs/retention-sweeper.js");

test("uploadNamesIn reads file names from /uploads/ URLs", () => {
    const names = uploadNamesIn(["/uploads/audio_1_a.webm", "https://certifriedmultitool.com/uploads/ai_cover_7_2_b.png?v=1", null, "https://x.test/y.png"]);
    assert.deepEqual([...names].sort(), ["ai_cover_7_2_b.png", "audio_1_a.webm"]);
});

test("only unreferenced card media older than a day is deleted", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "up-"));
    const now = Date.now();
    const old = now / 1000 - 3 * 86400;
    const fresh = now / 1000 - 3600;
    const files = {
        "audio_100_keep01.webm": old,          // used by a signature
        "audio_101_gone01.webm": old,          // nothing uses it
        "audio_102_new001.webm": fresh,        // nothing uses it yet, but under a day old
        "ai_cover_standalone_103_gone02.jpg": old,
        "ai_cover_5_104_keep02.png": old,      // a card points at it
        "card_5_page_1.png": old,              // card 5 exists
        "card_9_page_1.png": old,              // card 9 was deleted
        "avatar_1_2.png": old,                 // not card media: never touched
        "welcome_1_2.png": old,
    };
    for (const [name, t] of Object.entries(files)) { fs.writeFileSync(path.join(dir, name), "x"); fs.utimesSync(path.join(dir, name), t, t); }
    const refs = uploadNamesIn(["/uploads/audio_100_keep01.webm", "/uploads/ai_cover_5_104_keep02.png"]);
    const out = await pruneCardMediaFiles({ dir, refs, cardIds: new Set(["5"]), now });
    assert.equal(out.deleted, 3);
    assert.deepEqual(fs.readdirSync(dir).sort(), [
        "ai_cover_5_104_keep02.png", "audio_100_keep01.webm", "audio_102_new001.webm",
        "avatar_1_2.png", "card_5_page_1.png", "welcome_1_2.png",
    ]);
});

test("a missing folder is not an error", async () => {
    assert.deepEqual(await pruneCardMediaFiles({ dir: path.join(tmp, "nope"), refs: new Set(), cardIds: new Set() }), { deleted: 0 });
});
