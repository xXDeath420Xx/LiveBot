const db = require("../utils/db");
const apiChecks = require("../utils/api_checks");
const initCycleTLS = require("cycletls");

async function fixMissingPlatformIds() {
  console.log("[MIGRATE] Starting data migration script...");

  let cycleTLS = null;

  try {
    const [streamersToFix] = await db.execute(
      "SELECT streamer_id, platform, username FROM streamers WHERE platform_user_id IS NULL OR platform_user_id = \"\""
    );

    if (streamersToFix.length === 0) {
      console.log("[MIGRATE] No streamers found with missing platform_user_id. Database is likely already up to date.");
      return;
    }

    console.log(`[MIGRATE] Found ${streamersToFix.length} streamer(s) to fix...`);
    let fixedCount = 0;
    let failedCount = 0;

    if (streamersToFix.some(s => s.platform === "kick")) {
      cycleTLS = await initCycleTLS({timeout: 60000});
    }

    for (const streamer of streamersToFix) {
      console.log(`[MIGRATE] > Processing ${streamer.username} on ${streamer.platform}...`);
      let puid = null;

      try { // Added try-catch for individual API calls for robustness
        if (streamer.platform === "kick" && cycleTLS) {
          const kickUser = await apiChecks.getKickUser(cycleTLS, streamer.username);
          if (kickUser && kickUser.id) {
            puid = kickUser.id.toString();
          }
        } else if (streamer.platform === "twitch") {
          const twitchUser = await apiChecks.getTwitchUser(streamer.username);
          if (twitchUser && twitchUser.id) {
            puid = twitchUser.id;
          }
        } else if (streamer.platform === "youtube") {
          const youtubeChannelId = await apiChecks.getYouTubeChannelId(streamer.username);
          if (youtubeChannelId) {
            puid = youtubeChannelId;
          }
        }
      } catch (apiError) {
        // Log the specific API error but allow the loop to continue
        console.log(`[MIGRATE]   ❌ FAILED API Call for ${streamer.username} on ${streamer.platform}: ${apiError.message}`);
        // puid remains null, so it will be caught by the outer `if (puid)` check and logged as failed.
      }

      // Add a small delay to prevent hitting API rate limits during bulk operations
      await new Promise(resolve => setTimeout(resolve, 250)); // 250ms delay

      if (puid) {
        await db.execute(
          "UPDATE streamers SET platform_user_id = ? WHERE streamer_id = ?",
          [puid, streamer.streamer_id]
        );
        console.log(`[MIGRATE]   ✔️ SUCCESS: Updated ${streamer.username} with ID: ${puid}`);
        fixedCount++;
      } else {
        // This branch also catches streamers where puid remained null due to an API error
        console.log(`[MIGRATE]   ❌ FAILED: Could not find platform ID for ${streamer.username} on ${streamer.platform}. Please check the username.`);
        failedCount++;
      }
    }

    console.log("[MIGRATE] --- Migration Complete ---");
    console.log(`[MIGRATE] ${fixedCount} records successfully updated.`);
    console.log(`[MIGRATE] ${failedCount} records failed. Manual review may be needed.`);

  } catch (error) {
    console.error("[MIGRATE] A critical error occurred:", error);
  } finally {
    if (cycleTLS) {
      try {
        cycleTLS.exit();
      } catch (e) {
        console.error("[MIGRATE] Error exiting cycleTLS:", e);
      }
    }
    await db.end();
  }
}

fixMissingPlatformIds();