const SpotifyWebApi = require("spotify-web-api-node");
const logger = require("./logger");
const axios = require("axios"); // Import axios

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let tokenExpirationTime = 0;
let currentAccessToken = null; // Store the current access token

async function refreshAccessToken() {
  if (Date.now() < tokenExpirationTime && currentAccessToken) {
    return currentAccessToken;
  }

  try {
    const data = await spotifyApi.clientCredentialsGrant();
    currentAccessToken = data.body["access_token"];
    spotifyApi.setAccessToken(currentAccessToken);
    // Set expiration time to 5 minutes before it actually expires
    tokenExpirationTime = Date.now() + (data.body["expires_in"] - 300) * 1000;
    logger.info("[Spotify] Refreshed Access Token.");
    return currentAccessToken;
  } catch (error) {
    logger.error("[Spotify] Could not refresh access token:", { error: error.message });
    throw error; // Rethrow to be caught by the calling function
  }
}

async function getRecommendations(seed_artists, seed_genres, seed_tracks) {
    await refreshAccessToken();
    try {
        const options = {
            limit: 20,
            market: 'US',
        };

        if (seed_artists && seed_artists.length > 0) {
            options.seed_artists = seed_artists;
        }
        if (seed_genres && seed_genres.length > 0) {
            options.seed_genres = seed_genres;
        }
        if (seed_tracks && seed_tracks.length > 0) {
            options.seed_tracks = seed_tracks;
        }

        logger.info(`[Spotify] Calling getRecommendations with options: ${JSON.stringify(options)}`);
        const recommendations = await spotifyApi.getRecommendations(options);
        return recommendations.body.tracks;
    } catch (error) {
        let detailedErrorMessage = "Unknown error";
        let statusCode = null;
        if (error.statusCode) {
            statusCode = error.statusCode;
        }
        if (error.body) {
            detailedErrorMessage = JSON.stringify(error.body);
        } else if (error.message) {
            detailedErrorMessage = error.message;
        } else {
            detailedErrorMessage = JSON.stringify(error); // Fallback to stringify the whole error object
        }
        logger.error("[Spotify] Failed to get recommendations:", { message: detailedErrorMessage, statusCode: statusCode, fullError: error });
        return [];
    }
}

async function searchArtists(artistName) {
    await refreshAccessToken();
    try {
        logger.info(`[Spotify] searchArtists called for: ${artistName}`);
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

async function searchTracks(trackName, artistName = null) {
    await refreshAccessToken();
    try {
        logger.info(`[Spotify] searchTracks called for: ${trackName}, artist: ${artistName}`);
        let query = trackName;
        if (artistName) {
            query += ` artist:"${artistName}"`;
        }
        const data = await spotifyApi.searchTracks(query, { limit: 5 });
        if (data.body.tracks.items.length > 0) {
            if (artistName) {
                const matchingTrack = data.body.tracks.items.find(track =>
                    track.artists.some(artist => artist.name.toLowerCase() === artistName.toLowerCase())
                );
                return matchingTrack || data.body.tracks.items[0];
            }
            return data.body.tracks.items[0];
        }
        return null;
    } catch (error) {
        logger.error(`[Spotify] Failed to search for track '${trackName}' (artist: ${artistName}):`, { error: error.message });
        return null;
    }
}

async function getAvailableGenreSeeds() {
    await refreshAccessToken();
    try {
        const data = await spotifyApi.getAvailableGenreSeeds();
        return data.body.genres;
    } catch (error) {
        logger.error("[Spotify] Failed to get available genre seeds:", { error: error.message });
        return [];
    }
}

module.exports = { getRecommendations, searchArtists, searchTracks, getAvailableGenreSeeds };
