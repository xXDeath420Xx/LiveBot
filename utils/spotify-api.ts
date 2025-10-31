import SpotifyWebApi from "spotify-web-api-node";
import logger from "./logger";
// import axios from "axios";

// Spotify API Response Interfaces
interface SpotifyTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope?: string;
}

interface SpotifyError {
    statusCode?: number;
    body?: any;
    message?: string;
}

interface SpotifyExternalUrls {
    spotify: string;
}

interface SpotifyImage {
    url: string;
    height: number | null;
    width: number | null;
}

interface SpotifyFollowers {
    href: string | null;
    total: number;
}

interface SpotifyArtistSimplified {
    external_urls: SpotifyExternalUrls;
    href: string;
    id: string;
    name: string;
    type: "artist";
    uri: string;
}

interface SpotifyArtist extends SpotifyArtistSimplified {
    followers?: SpotifyFollowers;
    genres?: string[];
    images?: SpotifyImage[];
    popularity?: number;
}

interface SpotifyAlbumSimplified {
    album_type: "album" | "single" | "compilation";
    total_tracks: number;
    available_markets: string[];
    external_urls: SpotifyExternalUrls;
    href: string;
    id: string;
    images: SpotifyImage[];
    name: string;
    release_date: string;
    release_date_precision: "year" | "month" | "day";
    type: "album";
    uri: string;
    artists: SpotifyArtistSimplified[];
}

interface SpotifyTrack {
    album: SpotifyAlbumSimplified;
    artists: SpotifyArtist[];
    available_markets: string[];
    disc_number: number;
    duration_ms: number;
    explicit: boolean;
    external_ids?: {
        isrc?: string;
        ean?: string;
        upc?: string;
    };
    external_urls: SpotifyExternalUrls;
    href: string;
    id: string;
    is_playable?: boolean;
    linked_from?: any;
    restrictions?: {
        reason: string;
    };
    name: string;
    popularity: number;
    preview_url: string | null;
    track_number: number;
    type: "track";
    uri: string;
    is_local: boolean;
}

interface SpotifyRecommendationsResponse {
    seeds: Array<{
        afterFilteringSize: number;
        afterRelinkingSize: number;
        href: string | null;
        id: string;
        initialPoolSize: number;
        type: string;
    }>;
    tracks: SpotifyTrack[];
}

interface SpotifyArtistsSearchResponse {
    artists: {
        href: string;
        limit: number;
        next: string | null;
        offset: number;
        previous: string | null;
        total: number;
        items: SpotifyArtist[];
    };
}

interface SpotifyTracksSearchResponse {
    tracks: {
        href: string;
        limit: number;
        next: string | null;
        offset: number;
        previous: string | null;
        total: number;
        items: SpotifyTrack[];
    };
}

interface SpotifyGenreSeedsResponse {
    genres: string[];
}

interface RecommendationsOptions {
    limit: number;
    market: string;
    seed_artists?: string[];
    seed_genres?: string[];
    seed_tracks?: string[];
}

// Initialize Spotify API client
const spotifyApi: SpotifyWebApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let tokenExpirationTime: number = 0;
let currentAccessToken: string | null = null;

/**
 * Refreshes the Spotify access token if expired or returns the current token
 * @returns The current valid access token
 * @throws Error if token refresh fails
 */
async function refreshAccessToken(): Promise<string> {
    if (Date.now() < tokenExpirationTime && currentAccessToken) {
        return currentAccessToken;
    }

    try {
        const data = await spotifyApi.clientCredentialsGrant();
        const accessToken: string = data.body["access_token"];
        const expiresIn: number = data.body["expires_in"];

        currentAccessToken = accessToken;
        spotifyApi.setAccessToken(currentAccessToken);
        // Set expiration time to 5 minutes before it actually expires
        tokenExpirationTime = Date.now() + (expiresIn - 300) * 1000;
        logger.info("[Spotify] Refreshed Access Token.");
        return currentAccessToken;
    } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : "Unknown error";
        logger.error("[Spotify] Could not refresh access token:", { error: errorMessage });
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
async function getRecommendations(
    seed_artists: string[] | null | undefined,
    seed_genres: string[] | null | undefined,
    seed_tracks: string[] | null | undefined
): Promise<SpotifyTrack[]> {
    await refreshAccessToken();
    try {
        const options: RecommendationsOptions = {
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
        return recommendations.body.tracks as SpotifyTrack[];
    } catch (error: unknown) {
        let detailedErrorMessage: string = "Unknown error";
        let statusCode: number | null = null;

        const spotifyError = error as SpotifyError;

        if (spotifyError.statusCode) {
            statusCode = spotifyError.statusCode;
        }
        if (spotifyError.body) {
            detailedErrorMessage = JSON.stringify(spotifyError.body);
        } else if (spotifyError.message) {
            detailedErrorMessage = spotifyError.message;
        } else {
            detailedErrorMessage = JSON.stringify(error);
        }

        logger.error("[Spotify] Failed to get recommendations:", {
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
async function searchArtists(artistName: string): Promise<SpotifyArtist | null> {
    await refreshAccessToken();
    try {
        logger.info(`[Spotify] searchArtists called for: ${artistName}`);
        const data = await spotifyApi.searchArtists(artistName, { limit: 1 });
        const artists = data.body.artists;

        if (artists && artists.items.length > 0) {
            return artists.items[0] as SpotifyArtist;
        }
        return null;
    } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : "Unknown error";
        logger.error(`[Spotify] Failed to search for artist '${artistName}':`, { error: errorMessage });
        return null;
    }
}

/**
 * Search for tracks on Spotify, optionally filtered by artist
 * @param trackName - The name of the track to search for
 * @param artistName - Optional artist name to filter results
 * @returns The first matching track or null if not found
 */
async function searchTracks(trackName: string, artistName: string | null = null): Promise<SpotifyTrack | null> {
    await refreshAccessToken();
    try {
        logger.info(`[Spotify] searchTracks called for: ${trackName}, artist: ${artistName}`);
        let query: string = trackName;
        if (artistName) {
            query += ` artist:"${artistName}"`;
        }
        const data = await spotifyApi.searchTracks(query, { limit: 5 });
        const tracks = data.body.tracks;

        if (tracks && tracks.items.length > 0) {
            if (artistName) {
                const matchingTrack: SpotifyTrack | undefined = tracks.items.find((track: SpotifyTrack) =>
                    track.artists.some((artist: SpotifyArtist) =>
                        artist.name.toLowerCase() === artistName.toLowerCase()
                    )
                );
                return (matchingTrack || tracks.items[0]) as SpotifyTrack;
            }
            return tracks.items[0] as SpotifyTrack;
        }
        return null;
    } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : "Unknown error";
        logger.error(`[Spotify] Failed to search for track '${trackName}' (artist: ${artistName}):`, { error: errorMessage });
        return null;
    }
}

/**
 * Get available genre seeds from Spotify
 * @returns Array of available genre names or empty array on error
 */
async function getAvailableGenreSeeds(): Promise<string[]> {
    await refreshAccessToken();
    try {
        const data = await spotifyApi.getAvailableGenreSeeds();
        return data.body.genres as string[];
    } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : "Unknown error";
        logger.error("[Spotify] Failed to get available genre seeds:", { error: errorMessage });
        return [];
    }
}

export { getRecommendations, searchArtists, searchTracks, getAvailableGenreSeeds };
export default { getRecommendations, searchArtists, searchTracks, getAvailableGenreSeeds };
