"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRecommendations = getRecommendations;
exports.searchArtists = searchArtists;
exports.searchTracks = searchTracks;
exports.getAvailableGenreSeeds = getAvailableGenreSeeds;
const spotify_web_api_node_1 = __importDefault(require("spotify-web-api-node"));
const logger_1 = __importDefault(require("./logger"));
// Initialize Spotify API client
const spotifyApi = new spotify_web_api_node_1.default({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});
let tokenExpirationTime = 0;
let currentAccessToken = null;
/**
 * Refreshes the Spotify access token if expired or returns the current token
 * @returns The current valid access token
 * @throws Error if token refresh fails
 */
async function refreshAccessToken() {
    if (Date.now() < tokenExpirationTime && currentAccessToken) {
        return currentAccessToken;
    }
    try {
        const data = await spotifyApi.clientCredentialsGrant();
        const accessToken = data.body["access_token"];
        const expiresIn = data.body["expires_in"];
        currentAccessToken = accessToken;
        spotifyApi.setAccessToken(currentAccessToken);
        // Set expiration time to 5 minutes before it actually expires
        tokenExpirationTime = Date.now() + (expiresIn - 300) * 1000;
        logger_1.default.info("[Spotify] Refreshed Access Token.");
        return currentAccessToken;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        logger_1.default.error("[Spotify] Could not refresh access token:", { error: errorMessage });
        throw error;
    }
}
/**
 * Get track recommendations based on seed artists, genres, and tracks
 * @param seed_artists - Array of artist IDs for seeding recommendations
 * @param seed_genres - Array of genre names for seeding recommendations
 * @param seed_tracks - Array of track IDs for seeding recommendations
 * @returns Array of recommended tracks or empty array on error
 */
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
        logger_1.default.info(`[Spotify] Calling getRecommendations with options: ${JSON.stringify(options)}`);
        const recommendations = await spotifyApi.getRecommendations(options);
        return recommendations.body.tracks;
    }
    catch (error) {
        let detailedErrorMessage = "Unknown error";
        let statusCode = null;
        const spotifyError = error;
        if (spotifyError.statusCode) {
            statusCode = spotifyError.statusCode;
        }
        if (spotifyError.body) {
            detailedErrorMessage = JSON.stringify(spotifyError.body);
        }
        else if (spotifyError.message) {
            detailedErrorMessage = spotifyError.message;
        }
        else {
            detailedErrorMessage = JSON.stringify(error);
        }
        logger_1.default.error("[Spotify] Failed to get recommendations:", {
            message: detailedErrorMessage,
            statusCode: statusCode,
            fullError: error
        });
        return [];
    }
}
/**
 * Search for an artist on Spotify
 * @param artistName - The name of the artist to search for
 * @returns The first matching artist or null if not found
 */
async function searchArtists(artistName) {
    await refreshAccessToken();
    try {
        logger_1.default.info(`[Spotify] searchArtists called for: ${artistName}`);
        const data = await spotifyApi.searchArtists(artistName, { limit: 1 });
        const artists = data.body.artists;
        if (artists && artists.items.length > 0) {
            return artists.items[0];
        }
        return null;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        logger_1.default.error(`[Spotify] Failed to search for artist '${artistName}':`, { error: errorMessage });
        return null;
    }
}
/**
 * Search for tracks on Spotify, optionally filtered by artist
 * @param trackName - The name of the track to search for
 * @param artistName - Optional artist name to filter results
 * @returns The first matching track or null if not found
 */
async function searchTracks(trackName, artistName = null) {
    await refreshAccessToken();
    try {
        logger_1.default.info(`[Spotify] searchTracks called for: ${trackName}, artist: ${artistName}`);
        let query = trackName;
        if (artistName) {
            query += ` artist:"${artistName}"`;
        }
        const data = await spotifyApi.searchTracks(query, { limit: 5 });
        const tracks = data.body.tracks;
        if (tracks && tracks.items.length > 0) {
            if (artistName) {
                const matchingTrack = tracks.items.find((track) => track.artists.some((artist) => artist.name.toLowerCase() === artistName.toLowerCase()));
                return (matchingTrack || tracks.items[0]);
            }
            return tracks.items[0];
        }
        return null;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        logger_1.default.error(`[Spotify] Failed to search for track '${trackName}' (artist: ${artistName}):`, { error: errorMessage });
        return null;
    }
}
/**
 * Get available genre seeds from Spotify
 * @returns Array of available genre names or empty array on error
 */
async function getAvailableGenreSeeds() {
    await refreshAccessToken();
    try {
        const data = await spotifyApi.getAvailableGenreSeeds();
        return data.body.genres;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        logger_1.default.error("[Spotify] Failed to get available genre seeds:", { error: errorMessage });
        return [];
    }
}
exports.default = { getRecommendations, searchArtists, searchTracks, getAvailableGenreSeeds };
