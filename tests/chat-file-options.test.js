import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * A command typed in chat takes its file options from the files attached to the message. Before,
 * parseOptions filled a file option only while typed words were left over, so `/rpg character import`
 * with just the PDF attached (what /docs/rpg tells people to do) answered "Missing pdf".
 */
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chat-files-"));
const { parseOptions } = await import("../core/universal-commands.js");
const { MessageContextAdapter } = await import("../core/message-context-adapter.js");

const STRING = 3, USER = 6, ATTACHMENT = 11;
const file = (name) => ({ name, url: `https://cdn.discordapp.com/attachments/1/2/${name}` });
function message(...files) {
    const m = new Map(files.map((f, i) => [String(i), f]));
    return { attachments: { values: () => m.values(), first: () => files[0], size: files.length } };
}

test("a file option is filled from the attachment with no words typed", () => {
    const defs = [{ name: "pdf", type: ATTACHMENT, required: true }];
    assert.deepEqual(parseOptions(defs, [], message(file("sheet.pdf"))), { pdf: file("sheet.pdf") });
    assert.deepEqual(parseOptions(defs, [], message()), {});
});

test("words still fill the other options, and a file uses no word", () => {
    const defs = [{ name: "name", type: STRING, required: true }, { name: "file", type: ATTACHMENT, required: true }, { name: "emoji", type: STRING }];
    const args = parseOptions(defs, ["airhorn"], message(file("a.mp3")));
    assert.deepEqual(args, { file: file("a.mp3"), name: "airhorn" });
});

test("several file options take the attachments in order, required ones first", () => {
    const defs = [{ name: "extra", type: ATTACHMENT }, { name: "main", type: ATTACHMENT, required: true }];
    const args = parseOptions(defs, [], message(file("1.png"), file("2.png")));
    assert.equal(args.main.name, "1.png");
    assert.equal(args.extra.name, "2.png");
});

test("commands without files parse as before", () => {
    const defs = [{ name: "user", type: USER, required: true }, { name: "reason", type: STRING }];
    assert.deepEqual(parseOptions(defs, ["<@123456789012345678>", "spam", "links"], message()),
        { user: "<@123456789012345678>", reason: "spam links" });
});

test("getAttachment returns the file parseOptions picked for that option", () => {
    const msg = message(file("1.png"), file("2.png"));
    const defs = [{ name: "a", type: ATTACHMENT, required: true }, { name: "b", type: ATTACHMENT, required: true }];
    const ctx = new MessageContextAdapter({ ...msg, author: { id: "1" }, guild: null, channel: null, member: null, content: "", mentions: {} }, "x", parseOptions(defs, [], msg), {});
    assert.equal(ctx.options.getAttachment("a").name, "1.png");
    assert.equal(ctx.options.getAttachment("b").name, "2.png");
});
