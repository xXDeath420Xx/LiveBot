/**
 * Competitive Analyzer
 * Analyze other Discord bots to identify features we should implement/improve
 * Uses public bot directories and documentation
 */

import logger from './logger';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

/**
 * Competitor bot information
 */
interface CompetitorBot {
    name: string;
    url: string;
    category: string;
}

/**
 * Bot analysis result
 */
interface BotAnalysis {
    bot?: string;
    coreFeatures?: string[];
    uniqueFeatures?: string[];
    premiumFeatures?: string[];
    uxHighlights?: string[];
    weaknesses?: string[];
}

/**
 * Extended bot analysis with bot metadata
 */
interface ExtendedBotAnalysis extends CompetitorBot, BotAnalysis {
    error?: string;
}

/**
 * Comparative report structure
 */
interface ComparativeReport {
    missingFeatures?: string[];
    featuresCompetitorsHave?: string[];
    improvementAreas?: string[];
    areasToImprove?: string[];
    recommendations?: string[];
    [key: string]: unknown;
}

/**
 * Full analysis report
 */
interface AnalysisReport {
    timestamp: Date;
    competitorsAnalyzed: number;
    report: ComparativeReport;
}

/**
 * Feature gap analysis result
 */
interface FeatureGaps {
    missingFeatures: string[];
    improvementAreas: string[];
    recommendations: string[];
}

/**
 * Category comparison result
 */
interface CategoryComparison {
    essentialFeatures?: string[];
    advancedFeatures?: string[];
    commonMistakes?: string[];
    emergingTrends?: string[];
    [key: string]: unknown;
}

/**
 * Generic parsed JSON response (when JSON parsing fails)
 */
interface ParsedResponse {
    raw?: string;
    [key: string]: unknown;
}

class CompetitiveAnalyzer {
    private genAI: GoogleGenerativeAI | null;
    private model: GenerativeModel | null;
    private competitorBots: CompetitorBot[];

    constructor() {
        this.genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
        this.model = this.genAI ? this.genAI.getGenerativeModel({ model: 'gemini-pro' }) : null;
        this.competitorBots = [
            { name: 'MEE6', url: 'https://mee6.xyz', category: 'multi-purpose' },
            { name: 'Dyno', url: 'https://dyno.gg', category: 'moderation' },
            { name: 'Carl-bot', url: 'https://carl.gg', category: 'utility' },
            { name: 'ProBot', url: 'https://probot.io', category: 'multi-purpose' },
            { name: 'Arcane', url: 'https://arcanebot.xyz', category: 'leveling' },
            { name: 'Mudae', url: 'https://mudae.net', category: 'game' },
            { name: 'Dank Memer', url: 'https://dankmemer.lol', category: 'economy' },
            { name: 'Jockie Music', url: 'https://jockiemusic.com', category: 'music' }
        ];
    }

    /**
     * Run competitive analysis
     */
    async analyzeCompetition(): Promise<AnalysisReport | null> {
        if (!this.model) {
            logger.warn('[Competitive] Gemini API not available. Analysis disabled.');
            return null;
        }

        try {
            logger.info('[Competitive] Running competitive analysis...');

            const analyses: ExtendedBotAnalysis[] = [];

            for (const bot of this.competitorBots) {
                try {
                    const analysis = await this.analyzeBot(bot);
                    analyses.push(analysis);

                    // Rate limit: wait 2 seconds between requests
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (error) {
                    logger.error(`[Competitive] Failed to analyze ${bot.name}:`, error as Record<string, any>);
                }
            }

            // Generate comparative report
            const report = await this.generateComparativeReport(analyses);

            logger.info('[Competitive] Competitive analysis complete');

            return report;
        } catch (error) {
            logger.error('[Competitive] Analysis error:', error as Record<string, any>);
            return null;
        }
    }

    /**
     * Analyze a specific bot
     */
    async analyzeBot(bot: CompetitorBot): Promise<ExtendedBotAnalysis> {
        try {
            const prompt = `Based on your knowledge, what are the key features of the Discord bot "${bot.name}" (category: ${bot.category})?

List:
1. Core features
2. Unique selling points
3. Premium features (if any)
4. User experience highlights
5. Known weaknesses

Format as JSON:
{
  "bot": "${bot.name}",
  "coreFeatures": [],
  "uniqueFeatures": [],
  "premiumFeatures": [],
  "uxHighlights": [],
  "weaknesses": []
}`;

            if (!this.model) {
                throw new Error('Model not initialized');
            }

            const result = await this.model.generateContent(prompt);
            const response = result.response.text();

            // Parse AI response
            const analysis = this.parseJSON<BotAnalysis>(response);

            return {
                ...bot,
                ...analysis
            };
        } catch (error) {
            logger.error(`[Competitive] Error analyzing ${bot.name}:`, error as Record<string, any>);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { ...bot, error: errorMessage };
        }
    }

    /**
     * Generate comparative report
     */
    async generateComparativeReport(analyses: ExtendedBotAnalysis[]): Promise<AnalysisReport | null> {
        try {
            const prompt = `You are analyzing CertiFried MultiTool bot against competitors. CertiFried has:
- 7-platform streaming support (Twitch, Kick, YouTube, TikTok, Trovo, Facebook, Instagram)
- Complete economy system with shop, inventory, trading, 5 gambling games
- Multiple game systems (trivia with 10+ categories, hangman, counting)
- Production-grade moderation (ban/kick/mute/warn with timed actions, escalation)
- Advanced security (anti-raid, anti-nuke, join gate, quarantine)
- Comprehensive logging (message/member/voice/server logs)
- Complete ticket system with transcripts
- Music player with AI DJ (ElevenLabs + Piper TTS)
- Web dashboard with 130+ routes across 40+ management sections
- 200+ total features

Here are the competitor analyses:
${JSON.stringify(analyses, null, 2)}

Generate a report with:
1. Features CertiFried has that competitors don't
2. Features competitors have that CertiFried is missing
3. Areas where CertiFried could improve
4. Recommendations for staying competitive
5. Market positioning advice

Format as JSON with these keys.`;

            if (!this.model) {
                throw new Error('Model not initialized');
            }

            const result = await this.model.generateContent(prompt);
            const response = result.response.text();

            const report = this.parseJSON<ComparativeReport>(response);

            return {
                timestamp: new Date(),
                competitorsAnalyzed: analyses.length,
                report
            };
        } catch (error) {
            logger.error('[Competitive] Report generation error:', error as Record<string, any>);
            return null;
        }
    }

    /**
     * Compare specific feature category
     */
    async compareFeatureCategory(category: string): Promise<CategoryComparison | null> {
        const prompt = `Compare Discord bots in the "${category}" category. What are the must-have features and best practices?

Provide:
1. Essential features all bots should have
2. Advanced features that differentiate top bots
3. Common mistakes to avoid
4. Emerging trends in this category

Format as JSON.`;

        try {
            if (!this.model) {
                throw new Error('Model not initialized');
            }

            const result = await this.model.generateContent(prompt);
            const response = result.response.text();
            return this.parseJSON<CategoryComparison>(response);
        } catch (error) {
            logger.error(`[Competitive] Category comparison error for ${category}:`, error as Record<string, any>);
            return null;
        }
    }

    /**
     * Parse JSON from AI response
     */
    private parseJSON<T = ParsedResponse>(response: string): T {
        try {
            // Try to extract JSON from markdown code blocks
            const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                return JSON.parse(jsonMatch[1]) as T;
            }

            // Try direct JSON parse
            return JSON.parse(response) as T;
        } catch {
            // Return raw text if not JSON
            logger.warn('[Competitive] Failed to parse JSON, returning raw response');
            return { raw: response } as T;
        }
    }

    /**
     * Get feature gap analysis
     */
    async getFeatureGaps(): Promise<FeatureGaps | null> {
        const report = await this.analyzeCompetition();

        if (!report || !report.report) {
            return null;
        }

        return {
            missingFeatures: report.report.missingFeatures || report.report.featuresCompetitorsHave || [],
            improvementAreas: report.report.improvementAreas || report.report.areasToImprove || [],
            recommendations: report.report.recommendations || []
        };
    }
}

export = CompetitiveAnalyzer;
