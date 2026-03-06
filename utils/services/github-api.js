import axios from 'axios';
import logger from '../logger.js';

/**
 * GitHub API Service
 * API: https://docs.github.com/en/rest
 * Rate limits: 60/hour unauthenticated, 5000/hour authenticated
 */
export default class GitHubAPIService {
  constructor() {
    this.baseUrl = 'https://api.github.com';
    // Optional: Add GitHub personal access token for higher rate limits
    this.token = process.env.GITHUB_TOKEN || '';
    this.timeout = 10000;
  }

  /**
   * Get headers for API requests
   */
  getHeaders() {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Discord-Bot-CertiFriedUtility'
    };

    if (this.token) {
      headers['Authorization'] = `token ${this.token}`;
    }

    return headers;
  }

  /**
   * Get repository information
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<Object>} Repository details
   */
  async getRepository(owner, repo) {
    try {
      const response = await axios.get(`${this.baseUrl}/repos/${owner}/${repo}`, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      logger.error('[GitHub API] Error getting repository', {
        error: error.message,
        owner,
        repo
      });
      throw new Error('Failed to get repository information');
    }
  }

  /**
   * Get user profile information
   * @param {string} username - GitHub username
   * @returns {Promise<Object>} User profile details
   */
  async getUserProfile(username) {
    try {
      const response = await axios.get(`${this.baseUrl}/users/${username}`, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      logger.error('[GitHub API] Error getting user profile', {
        error: error.message,
        username
      });
      throw new Error('Failed to get user profile');
    }
  }

  /**
   * Get user's public repositories
   * @param {string} username - GitHub username
   * @param {number} perPage - Number of repos per page (max 100)
   * @returns {Promise<Array>} Array of repository objects
   */
  async getUserRepositories(username, perPage = 10) {
    try {
      const response = await axios.get(`${this.baseUrl}/users/${username}/repos`, {
        params: {
          sort: 'updated',
          per_page: Math.min(perPage, 100)
        },
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      logger.error('[GitHub API] Error getting user repositories', {
        error: error.message,
        username
      });
      throw new Error('Failed to get user repositories');
    }
  }

  /**
   * Get trending repositories
   * @param {string} language - Programming language filter (optional)
   * @param {string} since - Time period (daily, weekly, monthly)
   * @returns {Promise<Array>} Array of trending repository objects
   */
  async getTrendingRepositories(language = '', since = 'weekly') {
    try {
      // GitHub doesn't have an official trending API, so we use search with specific parameters
      const sinceDate = this.getSinceDate(since);

      let query = `created:>${sinceDate}`;
      if (language) {
        query += ` language:${language}`;
      }

      const response = await axios.get(`${this.baseUrl}/search/repositories`, {
        params: {
          q: query,
          sort: 'stars',
          order: 'desc',
          per_page: 10
        },
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      return response.data.items || [];
    } catch (error) {
      logger.error('[GitHub API] Error getting trending repositories', {
        error: error.message,
        language,
        since
      });
      throw new Error('Failed to get trending repositories');
    }
  }

  /**
   * Search repositories
   * @param {string} query - Search query
   * @param {number} perPage - Results per page
   * @returns {Promise<Array>} Array of repository objects
   */
  async searchRepositories(query, perPage = 5) {
    try {
      const response = await axios.get(`${this.baseUrl}/search/repositories`, {
        params: {
          q: query,
          sort: 'stars',
          order: 'desc',
          per_page: Math.min(perPage, 100)
        },
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      return response.data.items || [];
    } catch (error) {
      logger.error('[GitHub API] Error searching repositories', {
        error: error.message,
        query
      });
      throw new Error('Failed to search repositories');
    }
  }

  /**
   * Get repository languages
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<Object>} Languages object with byte counts
   */
  async getRepositoryLanguages(owner, repo) {
    try {
      const response = await axios.get(`${this.baseUrl}/repos/${owner}/${repo}/languages`, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      logger.error('[GitHub API] Error getting repository languages', {
        error: error.message,
        owner,
        repo
      });
      return {};
    }
  }

  /**
   * Get repository contributors
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} perPage - Number of contributors
   * @returns {Promise<Array>} Array of contributor objects
   */
  async getRepositoryContributors(owner, repo, perPage = 5) {
    try {
      const response = await axios.get(`${this.baseUrl}/repos/${owner}/${repo}/contributors`, {
        params: {
          per_page: Math.min(perPage, 100)
        },
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      logger.error('[GitHub API] Error getting repository contributors', {
        error: error.message,
        owner,
        repo
      });
      return [];
    }
  }

  /**
   * Get rate limit status
   * @returns {Promise<Object>} Rate limit information
   */
  async getRateLimit() {
    try {
      const response = await axios.get(`${this.baseUrl}/rate_limit`, {
        headers: this.getHeaders(),
        timeout: this.timeout
      });

      return response.data;
    } catch (error) {
      logger.error('[GitHub API] Error getting rate limit', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * Get date for trending repositories
   * @param {string} since - Time period (daily, weekly, monthly)
   * @returns {string} ISO date string
   */
  getSinceDate(since) {
    const date = new Date();

    switch (since) {
      case 'daily':
        date.setDate(date.getDate() - 1);
        break;
      case 'weekly':
        date.setDate(date.getDate() - 7);
        break;
      case 'monthly':
        date.setMonth(date.getMonth() - 1);
        break;
      default:
        date.setDate(date.getDate() - 7);
    }

    return date.toISOString().split('T')[0];
  }

  /**
   * Format repository data for Discord embed
   * @param {Object} repo - Repository object from GitHub API
   * @returns {Object} Formatted repository data
   */
  formatRepositoryData(repo) {
    const language = repo.language || 'Unknown';
    const stars = repo.stargazers_count?.toLocaleString() || '0';
    const forks = repo.forks_count?.toLocaleString() || '0';
    const issues = repo.open_issues_count?.toLocaleString() || '0';
    const watchers = repo.watchers_count?.toLocaleString() || '0';
    const license = repo.license?.name || 'No license';
    const createdAt = repo.created_at ? new Date(repo.created_at).toLocaleDateString() : 'Unknown';
    const updatedAt = repo.updated_at ? new Date(repo.updated_at).toLocaleDateString() : 'Unknown';

    return {
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description || 'No description provided.',
      owner: repo.owner.login,
      url: repo.html_url,
      homepage: repo.homepage,
      language,
      stars,
      forks,
      issues,
      watchers,
      license,
      createdAt,
      updatedAt,
      isPrivate: repo.private,
      isFork: repo.fork,
      defaultBranch: repo.default_branch || 'main'
    };
  }

  /**
   * Format user data for Discord embed
   * @param {Object} user - User object from GitHub API
   * @returns {Object} Formatted user data
   */
  formatUserData(user) {
    const followers = user.followers?.toLocaleString() || '0';
    const following = user.following?.toLocaleString() || '0';
    const publicRepos = user.public_repos?.toLocaleString() || '0';
    const createdAt = user.created_at ? new Date(user.created_at).toLocaleDateString() : 'Unknown';

    return {
      login: user.login,
      name: user.name || user.login,
      bio: user.bio || 'No bio provided.',
      company: user.company || 'N/A',
      location: user.location || 'N/A',
      email: user.email || 'N/A',
      blog: user.blog || 'N/A',
      followers,
      following,
      publicRepos,
      createdAt,
      avatarUrl: user.avatar_url,
      profileUrl: user.html_url,
      type: user.type
    };
  }
}
