import test from "node:test";
import assert from "node:assert/strict";
import { parseOllamaEndpoints, resolveFlaggedSample } from "../core/twitch-ai.js";
import { sqlNotBot } from "../utils/twitch-chat-bots.js";

test("legacy chain without #model uses the shared model for every endpoint", () => {
    assert.deepEqual(parseOllamaEndpoints("http://127.0.0.1:11434, http://127.0.0.1:11435/", "qwen2.5:7b"), [
        { url: "http://127.0.0.1:11434", model: "qwen2.5:7b" },
        { url: "http://127.0.0.1:11435", model: "qwen2.5:7b" },
    ]);
});

test("each endpoint can pin its own model; pipe separator still works", () => {
    assert.deepEqual(parseOllamaEndpoints("http://127.0.0.1:11434#qwen3.6:35b-a3b|http://127.0.0.1:11435#qwen2.5:7b", "x"), [
        { url: "http://127.0.0.1:11434", model: "qwen3.6:35b-a3b" },
        { url: "http://127.0.0.1:11435", model: "qwen2.5:7b" },
    ]);
});

test("empty model after # and blank entries fall back or drop", () => {
    assert.deepEqual(parseOllamaEndpoints("http://a:1#, ,#qwen", "d"), [{ url: "http://a:1", model: "d" }]);
    assert.deepEqual(parseOllamaEndpoints(null, "d"), []);
});

test("bot filter used for AI input excludes follow-alert and game bots", () => {
    const sql = sqlNotBot("m.chatter_user_login");
    for (const b of ["soundalerts", "pokemoncommunitygame", "frostytools", "wizebot"]) assert.match(sql, new RegExp(`'${b}'`));
    assert.match(sql, /NOT LIKE '%bot'/); // wzbot, sery_bot, etc.
});

test("moderation flag lands on the message its quote names, or is dropped", () => {
    const samples = [{ message_text: "hi chat" }, { message_text: "You are a talentless clown" }, { message_text: "nice shot" }];
    assert.equal(resolveFlaggedSample(samples, { i: 1, quote: "You are a talentless" }), samples[1]);
    assert.equal(resolveFlaggedSample(samples, { i: 0, quote: "you are a TALENTLESS" }), samples[1]); // wrong index, quote wins
    assert.equal(resolveFlaggedSample(samples, { i: 2, quote: "something not in the batch" }), null);
    assert.equal(resolveFlaggedSample(samples, { i: 2 }), samples[2]); // no quote: index as before
    assert.equal(resolveFlaggedSample(samples, { i: 9 }), null);
});

test("!feature keeps a feature off one endpoint", () => {
    assert.deepEqual(parseOllamaEndpoints("http://a:1#qwen3.6:35b-a3b,http://b:2#qwen2.5:7b!chat_moderate!raid_verify", "d"), [
        { url: "http://a:1", model: "qwen3.6:35b-a3b" },
        { url: "http://b:2", model: "qwen2.5:7b", skip: ["chat_moderate", "raid_verify"] },
    ]);
});
