import axios from 'axios';
import { decode } from 'html-entities';

/**
 * Utility for fetching trivia questions from Open Trivia Database API
 * API Documentation: https://opentdb.com/api_config.php
 */

// OpenTDB Category IDs mapping
const OPENTDB_CATEGORIES = {
  'general': 9,
  'entertainment': [11, 12, 13, 14], // Books, Film, Music, TV
  'science': 17,
  'technology': 18,
  'sports': 21,
  'geography': 22,
  'history': 23,
  'art': 25,
  'gaming': 15, // Video Games
  'music': 12,
  'random': null // No category filter
};

// Difficulty mapping
const OPENTDB_DIFFICULTY = {
  'easy': 'easy',
  'medium': 'medium',
  'hard': 'hard'
};

/**
 * Fetch trivia questions from OpenTDB
 * @param {Object} options - Query options
 * @param {string} options.category - Category key from OPENTDB_CATEGORIES
 * @param {string} options.difficulty - Difficulty: easy, medium, hard
 * @param {number} options.amount - Number of questions (max 50)
 * @param {string} options.type - Question type: multiple, boolean, or null for mixed
 * @returns {Promise<Array>} Array of question objects
 */
export async function fetchQuestions(options = {}) {
  const {
    category = 'random',
    difficulty = null,
    amount = 10,
    type = 'multiple'
  } = options;

  // Build API URL
  let url = `https://opentdb.com/api.php?amount=${Math.min(amount, 50)}`;

  // Add category
  if (category !== 'random' && OPENTDB_CATEGORIES[category]) {
    const categoryId = Array.isArray(OPENTDB_CATEGORIES[category])
      ? OPENTDB_CATEGORIES[category][Math.floor(Math.random() * OPENTDB_CATEGORIES[category].length)]
      : OPENTDB_CATEGORIES[category];
    url += `&category=${categoryId}`;
  }

  // Add difficulty
  if (difficulty && OPENTDB_DIFFICULTY[difficulty]) {
    url += `&difficulty=${OPENTDB_DIFFICULTY[difficulty]}`;
  }

  // Add type
  if (type) {
    url += `&type=${type}`;
  }

  // Add encoding to get properly formatted text
  url += '&encode=url3986';

  try {
    const response = await axios.get(url, { timeout: 10000 });

    if (response.data.response_code !== 0) {
      // Response codes:
      // 0: Success
      // 1: No Results
      // 2: Invalid Parameter
      // 3: Token Not Found
      // 4: Token Empty
      // 5: Rate Limit
      throw new Error(`OpenTDB API Error: Code ${response.data.response_code}`);
    }

    // Transform and decode questions
    return response.data.results.map(q => ({
      question: decodeURIComponent(q.question),
      correct_answer: decodeURIComponent(q.correct_answer),
      incorrect_answers: q.incorrect_answers.map(a => decodeURIComponent(a)),
      category: q.category,
      difficulty: q.difficulty,
      type: q.type
    }));
  } catch (error) {
    if (error.message.includes('response_code')) {
      throw error;
    }
    throw new Error(`Failed to fetch from OpenTDB: ${error.message}`);
  }
}

/**
 * Get a session token to avoid duplicate questions
 * Session tokens last for 6 hours
 * @returns {Promise<string>} Session token
 */
export async function getSessionToken() {
  try {
    const response = await axios.get('https://opentdb.com/api_token.php?command=request', {
      timeout: 5000
    });

    if (response.data.response_code === 0) {
      return response.data.token;
    }

    throw new Error('Failed to get session token');
  } catch (error) {
    throw new Error(`Session token error: ${error.message}`);
  }
}

/**
 * Reset a session token to get fresh questions
 * @param {string} token - Session token to reset
 * @returns {Promise<boolean>} Success status
 */
export async function resetSessionToken(token) {
  try {
    const response = await axios.get(
      `https://opentdb.com/api_token.php?command=reset&token=${token}`,
      { timeout: 5000 }
    );

    return response.data.response_code === 0;
  } catch (error) {
    return false;
  }
}

/**
 * Get category statistics from OpenTDB
 * @returns {Promise<Object>} Category statistics
 */
export async function getCategoryStats() {
  try {
    const response = await axios.get('https://opentdb.com/api_count_global.php', {
      timeout: 5000
    });

    return response.data.overall;
  } catch (error) {
    throw new Error(`Failed to get category stats: ${error.message}`);
  }
}

/**
 * Map internal category names to OpenTDB format
 * @param {string} internalCategory - Internal category name
 * @returns {string|null} OpenTDB category name or null for random
 */
export function mapCategoryToOpenTDB(internalCategory) {
  return OPENTDB_CATEGORIES[internalCategory] || null;
}

/**
 * Get available categories
 * @returns {Array<string>} List of category keys
 */
export function getAvailableCategories() {
  return Object.keys(OPENTDB_CATEGORIES);
}

export default {
  fetchQuestions,
  getSessionToken,
  resetSessionToken,
  getCategoryStats,
  mapCategoryToOpenTDB,
  getAvailableCategories
};
