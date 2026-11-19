import test from "node:test";
import assert from "node:assert/strict";
import { featureForCommand, FEATURE_SPECS } from "../core/feature-config-spec.js";

// /watch and /movie are one command (commands/media/watch.js reuses movie.js); the Watch party
// switch must stop both, not only the /movie name.
test("/watch and /movie are both gated by the Watch party switch", () => {
    assert.deepEqual(featureForCommand("movie"), { feature: "jellyfin", enabledKey: "enabled" });
    assert.deepEqual(featureForCommand("watch"), { feature: "jellyfin", enabledKey: "enabled" });
});

test("the Cinema and Watch party pages name /watch", () => {
    assert.deepEqual(FEATURE_SPECS.cinema.commands, ["/watch"]);
    assert.deepEqual(FEATURE_SPECS.jellyfin.commands, ["/watch"]);
});
