import axios from 'axios';
import logger from '../logger.js';

/**
 * The Movie Database (TMDb) API Service
 * API: https://developer.themoviedb.org
 * Free tier: Requires API key (free for non-commercial use)
 */
export default class TMDbAPIService {
  constructor() {
    this.baseUrl = 'https://api.themoviedb.org/3';
    this.imageBaseUrl = 'https://image.tmdb.org/t/p';
    // Get free API key at: https://www.themoviedb.org/settings/api
    this.apiKey = process.env.TMDB_API_KEY || '';
    this.timeout = 10000;
  }

  /**
   * Search for movies
   * @param {string} query - Search query
   * @param {number} page - Page number
   * @returns {Promise<Array>} Array of movie objects
   */
  async searchMovies(query, page = 1) {
    if (!this.apiKey) {
      throw new Error('TMDb API key not configured');
    }

    try {
      const response = await axios.get(`${this.baseUrl}/search/movie`, {
        params: {
          api_key: this.apiKey,
          query,
          page,
          language: 'en-US'
        },
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[TMDb API] Error searching movies', {
        error: error.message,
        query
      });
      throw new Error('Failed to search movies');
    }
  }

  /**
   * Search for TV shows
   * @param {string} query - Search query
   * @param {number} page - Page number
   * @returns {Promise<Array>} Array of TV show objects
   */
  async searchTV(query, page = 1) {
    if (!this.apiKey) {
      throw new Error('TMDb API key not configured');
    }

    try {
      const response = await axios.get(`${this.baseUrl}/search/tv`, {
        params: {
          api_key: this.apiKey,
          query,
          page,
          language: 'en-US'
        },
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[TMDb API] Error searching TV shows', {
        error: error.message,
        query
      });
      throw new Error('Failed to search TV shows');
    }
  }

  /**
   * Get movie details
   * @param {number} movieId - TMDb movie ID
   * @returns {Promise<Object>} Movie details
   */
  async getMovieDetails(movieId) {
    if (!this.apiKey) {
      throw new Error('TMDb API key not configured');
    }

    try {
      const response = await axios.get(`${this.baseUrl}/movie/${movieId}`, {
        params: {
          api_key: this.apiKey,
          language: 'en-US',
          append_to_response: 'credits,videos'
        },
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      logger.error('[TMDb API] Error getting movie details', {
        error: error.message,
        movieId
      });
      throw new Error('Failed to get movie details');
    }
  }

  /**
   * Get TV show details
   * @param {number} tvId - TMDb TV show ID
   * @returns {Promise<Object>} TV show details
   */
  async getTVDetails(tvId) {
    if (!this.apiKey) {
      throw new Error('TMDb API key not configured');
    }

    try {
      const response = await axios.get(`${this.baseUrl}/tv/${tvId}`, {
        params: {
          api_key: this.apiKey,
          language: 'en-US',
          append_to_response: 'credits,videos'
        },
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      logger.error('[TMDb API] Error getting TV details', {
        error: error.message,
        tvId
      });
      throw new Error('Failed to get TV show details');
    }
  }

  /**
   * Get trending movies
   * @param {string} timeWindow - 'day' or 'week'
   * @returns {Promise<Array>} Array of movie objects
   */
  async getTrendingMovies(timeWindow = 'week') {
    if (!this.apiKey) {
      throw new Error('TMDb API key not configured');
    }

    try {
      const response = await axios.get(`${this.baseUrl}/trending/movie/${timeWindow}`, {
        params: {
          api_key: this.apiKey,
          language: 'en-US'
        },
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[TMDb API] Error getting trending movies', {
        error: error.message
      });
      throw new Error('Failed to get trending movies');
    }
  }

  /**
   * Get trending TV shows
   * @param {string} timeWindow - 'day' or 'week'
   * @returns {Promise<Array>} Array of TV show objects
   */
  async getTrendingTV(timeWindow = 'week') {
    if (!this.apiKey) {
      throw new Error('TMDb API key not configured');
    }

    try {
      const response = await axios.get(`${this.baseUrl}/trending/tv/${timeWindow}`, {
        params: {
          api_key: this.apiKey,
          language: 'en-US'
        },
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[TMDb API] Error getting trending TV shows', {
        error: error.message
      });
      throw new Error('Failed to get trending TV shows');
    }
  }

  /**
   * Get movie recommendations
   * @param {number} movieId - TMDb movie ID
   * @returns {Promise<Array>} Array of recommended movie objects
   */
  async getMovieRecommendations(movieId) {
    if (!this.apiKey) {
      throw new Error('TMDb API key not configured');
    }

    try {
      const response = await axios.get(`${this.baseUrl}/movie/${movieId}/recommendations`, {
        params: {
          api_key: this.apiKey,
          language: 'en-US'
        },
        timeout: this.timeout
      });

      return response.data.results || [];
    } catch (error) {
      logger.error('[TMDb API] Error getting movie recommendations', {
        error: error.message,
        movieId
      });
      throw new Error('Failed to get movie recommendations');
    }
  }

  /**
   * Get poster URL
   * @param {string} posterPath - Poster path from TMDb
   * @param {string} size - Size (w92, w154, w185, w342, w500, w780, original)
   * @returns {string} Full poster URL
   */
  getPosterUrl(posterPath, size = 'w500') {
    if (!posterPath) return null;
    return `${this.imageBaseUrl}/${size}${posterPath}`;
  }

  /**
   * Get backdrop URL
   * @param {string} backdropPath - Backdrop path from TMDb
   * @param {string} size - Size (w300, w780, w1280, original)
   * @returns {string} Full backdrop URL
   */
  getBackdropUrl(backdropPath, size = 'w1280') {
    if (!backdropPath) return null;
    return `${this.imageBaseUrl}/${size}${backdropPath}`;
  }

  /**
   * Format movie data for Discord embed
   * @param {Object} movie - Movie object from TMDb API
   * @returns {Object} Formatted movie data
   */
  formatMovieData(movie) {
    const genres = movie.genres?.map(g => g.name).join(', ') || 'Unknown';
    const releaseDate = movie.release_date || 'Unknown';
    const runtime = movie.runtime ? `${movie.runtime} min` : 'N/A';
    const rating = movie.vote_average ? `${movie.vote_average.toFixed(1)}/10` : 'No rating';
    const voteCount = movie.vote_count ? `(${movie.vote_count.toLocaleString()} votes)` : '';

    // Get director
    const director = movie.credits?.crew?.find(c => c.job === 'Director')?.name || 'Unknown';

    // Get main cast (top 5)
    const cast = movie.credits?.cast?.slice(0, 5).map(c => c.name).join(', ') || 'N/A';

    // Get trailer
    const trailer = movie.videos?.results?.find(v => v.type === 'Trailer' && v.site === 'YouTube');
    const trailerUrl = trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null;

    return {
      id: movie.id,
      title: movie.title,
      overview: movie.overview || 'No overview available.',
      genres,
      releaseDate,
      runtime,
      rating,
      voteCount,
      director,
      cast,
      posterUrl: this.getPosterUrl(movie.poster_path),
      backdropUrl: this.getBackdropUrl(movie.backdrop_path),
      trailerUrl,
      tmdbUrl: `https://www.themoviedb.org/movie/${movie.id}`
    };
  }

  /**
   * Format TV show data for Discord embed
   * @param {Object} tv - TV show object from TMDb API
   * @returns {Object} Formatted TV show data
   */
  formatTVData(tv) {
    const genres = tv.genres?.map(g => g.name).join(', ') || 'Unknown';
    const firstAirDate = tv.first_air_date || 'Unknown';
    const status = tv.status || 'Unknown';
    const rating = tv.vote_average ? `${tv.vote_average.toFixed(1)}/10` : 'No rating';
    const voteCount = tv.vote_count ? `(${tv.vote_count.toLocaleString()} votes)` : '';
    const seasons = tv.number_of_seasons || 'Unknown';
    const episodes = tv.number_of_episodes || 'Unknown';

    // Get main cast (top 5)
    const cast = tv.credits?.cast?.slice(0, 5).map(c => c.name).join(', ') || 'N/A';

    // Get trailer
    const trailer = tv.videos?.results?.find(v => v.type === 'Trailer' && v.site === 'YouTube');
    const trailerUrl = trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null;

    return {
      id: tv.id,
      title: tv.name,
      overview: tv.overview || 'No overview available.',
      genres,
      firstAirDate,
      status,
      rating,
      voteCount,
      seasons,
      episodes,
      cast,
      posterUrl: this.getPosterUrl(tv.poster_path),
      backdropUrl: this.getBackdropUrl(tv.backdrop_path),
      trailerUrl,
      tmdbUrl: `https://www.themoviedb.org/tv/${tv.id}`
    };
  }
}
