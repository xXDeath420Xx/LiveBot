/**
 * CertiFried Extension - Achievements Component
 * Display and claim achievements
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { api } from '../api/client.js';

class CFAchievements extends CFBaseComponent {
    constructor() {
        super();
        this._achievements = [];
        this._isLoading = true;
    }

    onMount() {
        this._loadAchievements();

        this.on('click', '.cf-achievement__claim-btn', async (e) => {
            const btn = e.target.closest('.cf-achievement__claim-btn');
            if (!btn || btn.disabled) return;
            const achievementId = parseInt(btn.dataset.achievementId, 10);
            await this._claimAchievement(achievementId);
        });
    }

    async _loadAchievements() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._achievements.length === 0;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            const data = await api.getAchievements();
            this._achievements = data.achievements || [];
            this._totalUnlocked = data.totalUnlocked || 0;
            this._totalAchievements = data.totalAchievements || 0;

        } catch (error) {
            console.error('Failed to load achievements:', error);
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    async _claimAchievement(achievementId) {
        try {
            const result = await api.claimAchievement(achievementId);

            // Update local state
            const achievement = this._achievements.find(a => a.id === achievementId);
            if (achievement) {
                achievement.claimed = true;
            }

            this.emit('notification', {
                type: 'success',
                message: result.message || 'Achievement claimed!'
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

            this.render();

        } catch (error) {
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to claim'
            });
        }
    }

    render() {
        this.className = 'cf-achievements';

        if (this._isLoading) {
            this.setContent(
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' })
                )
            );
            return;
        }

        // Separate unlocked and locked achievements
        const unlocked = this._achievements.filter(a => a.unlocked);
        const locked = this._achievements.filter(a => !a.unlocked);

        this.setContent(
            // Progress summary
            h('div', { class: 'cf-achievements__summary mb-4' },
                h('div', { class: 'cf-stat' },
                    h('span', { class: 'cf-stat__value' }, `${this._totalUnlocked}/${this._totalAchievements}`),
                    h('span', { class: 'cf-stat__label' }, 'Achievements Unlocked')
                )
            ),

            // Unlocked achievements (claimable first)
            unlocked.length > 0 && h('div', { class: 'cf-achievements__section mb-4' },
                h('h3', { class: 'text-sm font-semibold text-muted mb-2' }, 'Unlocked'),
                ...unlocked
                    .sort((a, b) => (a.claimed ? 1 : 0) - (b.claimed ? 1 : 0))
                    .map(a => this._renderAchievement(a))
            ),

            // Locked achievements
            locked.length > 0 && h('div', { class: 'cf-achievements__section' },
                h('h3', { class: 'text-sm font-semibold text-muted mb-2' }, 'In Progress'),
                ...locked.map(a => this._renderAchievement(a))
            ),

            // Empty state
            this._achievements.length === 0 && h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No achievements yet'),
                h('p', { class: 'cf-empty__description' }, 'Start playing to unlock achievements!')
            )
        );
    }

    _renderAchievement(achievement) {
        const { unlocked, claimed, progress, name, description, rewardCash, rewardXp, rewardPrestigeTokens } = achievement;

        let statusClass = '';
        if (claimed) statusClass = 'cf-achievement--claimed';
        else if (unlocked) statusClass = 'cf-achievement--unlocked';

        return h('div', { class: `cf-achievement ${statusClass}` },
            // Icon
            h('div', { class: 'cf-achievement__icon' },
                unlocked ? this._renderTrophyIcon() : this._renderLockIcon()
            ),

            // Info
            h('div', { class: 'cf-achievement__info' },
                h('div', { class: 'cf-achievement__name' }, name),
                h('div', { class: 'cf-achievement__desc' }, description),

                // Progress bar for locked achievements
                !unlocked && h('div', { class: 'cf-achievement__progress-wrap' },
                    h('div', { class: 'cf-achievement__progress-bar' },
                        h('div', {
                            class: 'cf-achievement__progress-fill',
                            style: { width: `${progress}%` }
                        })
                    ),
                    h('span', { class: 'cf-achievement__progress-text' }, `${progress}%`)
                ),

                // Rewards
                (rewardCash > 0 || rewardXp > 0 || rewardPrestigeTokens > 0) &&
                h('div', { class: 'cf-achievement__rewards' },
                    rewardCash > 0 && h('span', { class: 'cf-achievement__reward' }, `${formatCurrency(rewardCash)}`),
                    rewardXp > 0 && h('span', { class: 'cf-achievement__reward' }, `+${rewardXp} XP`),
                    rewardPrestigeTokens > 0 && h('span', { class: 'cf-achievement__reward' }, `+${rewardPrestigeTokens} PT`)
                )
            ),

            // Claim button for unlocked, unclaimed achievements
            unlocked && !claimed && h('button', {
                class: 'cf-achievement__claim-btn cf-btn cf-btn--primary cf-btn--sm',
                dataset: { achievementId: achievement.id.toString() }
            }, 'Claim'),

            // Claimed checkmark
            claimed && h('div', { class: 'cf-achievement__claimed-icon' }, this._renderCheckIcon())
        );
    }

    _renderTrophyIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'var(--color-accent-500)');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z');
        svg.appendChild(path);

        return svg;
    }

    _renderLockIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'var(--text-muted)');
        svg.setAttribute('stroke-width', '2');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 17a2 2 0 100-4 2 2 0 000 4zm6-6V9a6 6 0 10-12 0v2m2 10h8a2 2 0 002-2v-6a2 2 0 00-2-2H8a2 2 0 00-2 2v6a2 2 0 002 2z');
        svg.appendChild(path);

        return svg;
    }

    _renderCheckIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'var(--color-success)');
        svg.setAttribute('stroke-width', '3');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M5 13l4 4L19 7');
        svg.appendChild(path);

        return svg;
    }
}

registerComponent('cf-achievements', CFAchievements);
export default CFAchievements;
