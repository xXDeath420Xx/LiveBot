/**
 * CertiFried Extension - Quests Component
 * Daily and weekly quest tracking
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatTimeRemaining } from '../utils/format.js';
import { api } from '../api/client.js';

class CFQuests extends CFBaseComponent {
    constructor() {
        super();
        this._activeTab = 'daily';
    }

    _setupSubscriptions() {
        this.subscribe('quests');
    }

    onMount() {
        // Tab switching
        this.on('click', '.cf-quests__tab', (e) => {
            const tab = e.target.closest('.cf-quests__tab');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        // Claim quest
        this.on('click', '.cf-quest__claim', async (e) => {
            const claimBtn = e.target.closest('.cf-quest__claim');
            if (!claimBtn) return;
            const questId = claimBtn.dataset.questId;
            await this._claimQuest(questId);
        });
    }

    render() {
        const daily = this.getState('quests.daily') || [];
        const weekly = this.getState('quests.weekly') || [];
        const isLoading = this.getState('quests.isLoading');

        const activeQuests = this._activeTab === 'daily' ? daily : weekly;

        this.className = 'cf-section cf-section--quests';
        this.setContent(
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Quests')
            ),

            // Tabs
            h('div', { class: 'cf-tabs' },
                h('button', {
                    class: `cf-tab cf-quests__tab ${this._activeTab === 'daily' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'daily' }
                }, `Daily (${daily.length})`),
                h('button', {
                    class: `cf-tab cf-quests__tab ${this._activeTab === 'weekly' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'weekly' }
                }, `Weekly (${weekly.length})`)
            ),

            // Reset timer
            h('div', { class: 'text-xs text-muted text-center mt-2' },
                this._activeTab === 'daily'
                    ? `Resets in ${this._getTimeUntilReset('daily')}`
                    : `Resets in ${this._getTimeUntilReset('weekly')}`
            ),

            // Loading
            isLoading && h('div', { class: 'cf-loading mt-4' },
                h('div', { class: 'cf-spinner' })
            ),

            // Quests list
            !isLoading && activeQuests.length === 0 && h('div', { class: 'cf-empty mt-4' },
                h('p', { class: 'cf-empty__title' }, 'No quests available'),
                h('p', { class: 'cf-empty__description' }, 'Check back later!')
            ),

            !isLoading && activeQuests.length > 0 && h('div', { class: 'cf-quests-list mt-3' },
                ...activeQuests.map(quest => this._renderQuest(quest))
            )
        );
    }

    _renderQuest(quest) {
        const progress = Math.min(quest.progress || 0, quest.target || 1);
        const progressPercent = (progress / (quest.target || 1)) * 100;
        const isComplete = progress >= (quest.target || 1);
        const isClaimed = quest.status === 'claimed';

        // Support both camelCase and snake_case from API
        const rewardCash = quest.rewardCash || quest.reward_cash || 0;
        const rewardXp = quest.rewardXp || quest.reward_xp || 0;
        const questName = quest.name || quest.title || quest.objective_type || 'Quest';

        return h('div', {
            class: `cf-quest ${isComplete ? 'cf-quest--completed' : ''} ${isClaimed ? 'cf-quest--claimed' : ''}`
        },
            h('div', { class: 'cf-quest__header' },
                h('span', { class: 'cf-quest__title' }, questName),
                h('div', { class: 'cf-quest__reward' },
                    this._renderRewardIcon(rewardCash > 0 ? 'cash' : 'xp'),
                    h('span', {}, rewardCash > 0 ? `+${formatCurrency(rewardCash)}` : `+${rewardXp} XP`)
                )
            ),

            h('p', { class: 'cf-quest__description' },
                quest.description || this._generateDescription(quest)
            ),

            // Progress bar
            h('div', { class: 'cf-progress cf-progress--sm' },
                h('div', {
                    class: 'cf-progress__bar',
                    style: { width: `${progressPercent}%` }
                })
            ),

            h('div', { class: 'cf-quest__progress-text' },
                h('span', {}, `${progress} / ${quest.target}`),
                isComplete && !isClaimed && h('button', {
                    class: 'cf-quest__claim cf-btn cf-btn--primary cf-btn--sm',
                    dataset: { questId: quest.id?.toString() }
                }, 'Claim'),
                isClaimed && h('span', { class: 'text-success' }, 'Claimed!')
            )
        );
    }

    _generateDescription(quest) {
        const descriptions = {
            harvest_plants: `Harvest ${quest.target} plants`,
            sell_items: `Sell ${quest.target} items`,
            breed_strains: `Complete ${quest.target} breeding`,
            earn_currency: `Earn ${formatCurrency(quest.target)}`,
            reach_level: `Reach level ${quest.target}`,
            complete_trades: `Complete ${quest.target} trades`
        };
        return descriptions[quest.objective_type] || quest.objective_type;
    }

    _renderRewardIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'var(--color-accent-500)');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

        if (type === 'xp') {
            path.setAttribute('d', 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z');
        } else {
            // Currency icon
            path.setAttribute('d', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.31-8.86c-1.77-.45-2.34-.94-2.34-1.67 0-.84.79-1.43 2.1-1.43 1.38 0 1.9.66 1.94 1.64h1.71c-.05-1.34-.87-2.57-2.49-2.97V5H10.9v1.69c-1.51.32-2.72 1.3-2.72 2.81 0 1.79 1.49 2.69 3.66 3.21 1.95.46 2.34 1.15 2.34 1.87 0 .53-.39 1.39-2.1 1.39-1.6 0-2.23-.72-2.32-1.64H8.04c.1 1.7 1.36 2.66 2.86 2.97V19h2.34v-1.67c1.52-.29 2.72-1.16 2.73-2.77-.01-2.2-1.9-2.96-3.66-3.42z');
        }

        svg.appendChild(path);
        return svg;
    }

    _getTimeUntilReset(type) {
        const now = new Date();
        let reset;

        if (type === 'daily') {
            // Next midnight UTC
            reset = new Date(now);
            reset.setUTCHours(24, 0, 0, 0);
        } else {
            // Next Monday midnight UTC
            reset = new Date(now);
            const daysUntilMonday = (8 - reset.getUTCDay()) % 7 || 7;
            reset.setUTCDate(reset.getUTCDate() + daysUntilMonday);
            reset.setUTCHours(0, 0, 0, 0);
        }

        return formatTimeRemaining(reset.getTime() - now.getTime(), true);
    }

    async _claimQuest(questId) {
        try {
            const result = await api.claimQuest(questId);

            // Update quest status in state
            const daily = this.getState('quests.daily') || [];
            const weekly = this.getState('quests.weekly') || [];

            const updateQuests = (quests) => quests.map(q =>
                q.id?.toString() === questId ? { ...q, status: 'claimed' } : q
            );

            this.setState('quests.daily', updateQuests(daily));
            this.setState('quests.weekly', updateQuests(weekly));

            // Format reward message - result.rewards has cash, xp, prestigeTokens
            const rewards = result.rewards || {};
            let rewardMsg = 'Quest claimed!';
            if (rewards.cash > 0) rewardMsg += ` +${formatCurrency(rewards.cash)}`;
            if (rewards.xp > 0) rewardMsg += ` +${rewards.xp} XP`;
            if (rewards.prestigeTokens > 0) rewardMsg += ` +${rewards.prestigeTokens} Prestige`;

            this.emit('notification', {
                type: 'success',
                message: rewardMsg
            });

            // Update player currency/xp immediately for live UI update
            if (result.newCash !== undefined) {
                this.setState('player.currency', result.newCash);
                this.setState('player.cash', result.newCash);
            }
            if (result.newXp !== undefined) {
                this.setState('player.xp', result.newXp);
            }
            if (result.newLevel !== undefined) {
                this.setState('player.level', result.newLevel);
            }

        } catch (error) {
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to claim quest'
            });
        }
    }
}

registerComponent('cf-quests', CFQuests);
export default CFQuests;
