const SpotifyWebApi = require("spotify-web-api-node");
const logger = require("./logger");

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let tokenExpirationTime = 0;

async function refreshAccessToken() {
  if (Date.now() < tokenExpirationTime) {
    return;
  }

  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body["access_token"]);
    // Set expiration time to 5 minutes before it actually expires
    tokenExpirationTime = Date.now() + (data.body["expires_in"] - 300) * 1000;
    logger.info("[Spotify] Refreshed Access Token.");
  } catch (error) {
    logger.error("[Spotify] Could not refresh access token:", { error: error.message });
    throw error; // Rethrow to be caught by the calling function
  }
}

async function getRecommendations(seed_artists, seed_genres, seed_tracks) {
    await refreshAccessToken();
    try {
        const recommendations = await spotifyApi.getRecommendations({
            seed_artists,
            seed_genres,
            seed_tracks,
            limit: 20, // Get a decent number of tracks
        });
        return recommendations.body.tracks;
    } catch (error) {
        logger.error("[Spotify] Failed to get recommendations:", { error: error.message });
        return [];
    }
}

async function searchArtists(artistName) {
    await refreshAccessToken();
    try {
        const data = await spotifyApi.searchArtists(artistName, { limit: 1 });
        if (data.body.artists.items.length > 0) {
            return data.body.artists.items[0];
        }
        return null;
    } catch (error) {
        logger.error(`[Spotify] Failed to search for artist '${artistName}':`, { error: error.message });
        return null;
    }
}

module.exports = { getRecommendations, searchArtists };
