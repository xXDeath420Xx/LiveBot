/**
 * Intelligence Systems Initializer
 * Initializes self-healing, self-learning, and competitive analysis systems
 */

const { logger } = require('./utils/logger');

async function initializeIntelligenceSystems(client) {
    logger.info('[Intelligence] Initializing bot intelligence systems...');

    try {
        // Initialize Self-Healing Manager
        const SelfHealingManager = require('./core/self-healing-manager');
        const selfHealing = new SelfHealingManager(client);
        await selfHealing.initialize();
        client.selfHealing = selfHealing;

        // Initialize Self-Learning Manager
        const SelfLearningManager = require('./core/self-learning-manager');
        const selfLearning = new SelfLearningManager(client);
        await selfLearning.initialize();
        client.selfLearning = selfLearning;

        // Initialize Competitive Analyzer (runs in background)
        const CompetitiveAnalyzer = require('./utils/competitive-analyzer');
        const competitiveAnalyzer = new CompetitiveAnalyzer();
        client.competitiveAnalyzer = competitiveAnalyzer;

        // Run initial competitive analysis (async, don't wait)
        setTimeout(async () => {
            try {
                logger.info('[Intelligence] Running initial competitive analysis...');
                const report = await competitiveAnalyzer.analyzeCompetition();
                if (report) {
                    logger.info('[Intelligence] Competitive analysis complete. Check insights in database.');
                }
            } catch (error) {
                logger.error('[Intelligence] Competitive analysis error:', error);
            }
        }, 60000); // Run after 1 minute to let bot fully initialize

        // Schedule weekly competitive analysis
        setInterval(async () => {
            try {
                logger.info('[Intelligence] Running weekly competitive analysis...');
                const report = await competitiveAnalyzer.analyzeCompetition();
                if (report) {
                    logger.info('[Intelligence] Weekly competitive analysis complete.');
                }
            } catch (error) {
                logger.error('[Intelligence] Weekly competitive analysis error:', error);
            }
        }, 7 * 24 * 60 * 60 * 1000); // Every 7 days

        logger.info('[Intelligence] All intelligence systems initialized successfully ✅');

        return {
            selfHealing,
            selfLearning,
            competitiveAnalyzer
        };
    } catch (error) {
        logger.error('[Intelligence] Failed to initialize intelligence systems:', error);
        throw error;
    }
}

module.exports = { initializeIntelligenceSystems };
