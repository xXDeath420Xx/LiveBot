/**
 * CertiFried Extension - Daily Rewards Component
 * Shows daily login streak and claimable rewards
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';

class CFDailyRewards extends CFBaseComponent {
    constructor() {
        super();
        this._rewardData = null;
        this._isLoading = true;
        this._isClaiming = false;
    }

    onMount() {
        this._loadRewardStatus();

        this.on('click', '.cf-daily__claim-btn', async () => {
            await this._claimReward();
        });

        this.on('click', '.cf-daily__close', () => {
            this.emit('close-daily-rewards');
        });
    }

    async _loadRewardStatus() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = !this._rewardData;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            const data = await api.getDailyRewardStatus();
            this._rewardData = data;

        } catch (error) {
            console.error('Failed to load daily rewards:', error);
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    async _claimReward() {
        if (this._isClaiming || this._rewardData?.alreadyClaimed) return;

        try {
            this._isClaiming = true;
            this.render();

            const result = await api.claimDailyReward();

            // Update local state
            if (this._rewardData) {
                this._rewardData.alreadyClaimed = true;
                this._rewardData.canClaim = false;
                this._rewardData.currentStreak = result.streak;
            }

            // Update player currency if cash was awarded
            if (result.newCash !== undefined) {
                this.setState('player.currency', result.newCash);
            }

            this.emit('notification', {
                type: 'success',
                message: `Day ${result.streak} reward claimed: ${result.reward.label}!`
            });

        } catch (error) {
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to claim reward'
            });
        } finally {
            this._isClaiming = false;
            this.render();
        }
    }

    render() {
        this.className = 'cf-daily-rewards';

        if (this._isLoading) {
            this.setContent(
                h('div', { class: 'cf-daily__loading' },
                    h('div', { class: 'cf-spinner' }),
                    h('p', {}, 'Loading rewards...')
                )
            );
            return;
        }

        const data = this._rewardData;
        if (!data) {
            this.setContent(
                h('div', { class: 'cf-daily__error' },
                    h('p', {}, 'Failed to load daily rewards')
                )
            );
            return;
        }

        this.setContent(
            // Header
            h('div', { class: 'cf-daily__header' },
                h('h2', {}, 'Daily Rewards'),
                h('button', { class: 'cf-daily__close cf-btn cf-btn--ghost' }, '×')
            ),

            // Streak display
            h('div', { class: 'cf-daily__streak' },
                h('div', { class: 'cf-daily__streak-icon' }, this._renderFlameIcon()),
                h('div', { class: 'cf-daily__streak-info' },
                    h('span', { class: 'cf-daily__streak-count' }, data.currentStreak.toString()),
                    h('span', { class: 'cf-daily__streak-label' }, 'Day Streak')
                ),
                h('div', { class: 'cf-daily__streak-best text-xs text-muted' },
                    `Best: ${data.highestStreak} days`
                )
            ),

            // Reward grid (7 days)
            h('div', { class: 'cf-daily__grid' },
                ...data.upcomingRewards.map((reward, i) => this._renderRewardDay(reward, i + 1, data))
            ),

            // Claim button
            h('div', { class: 'cf-daily__actions' },
                h('button', {
                    class: `cf-daily__claim-btn cf-btn cf-btn--primary ${data.alreadyClaimed ? 'cf-btn--disabled' : ''}`,
                    disabled: data.alreadyClaimed || this._isClaiming
                },
                    this._isClaiming ? 'Claiming...' :
                    data.alreadyClaimed ? 'Already Claimed Today' :
                    `Claim Day ${data.todayReward.day} Reward`
                )
            )
        );
    }

    _renderRewardDay(reward, dayNum, data) {
        const isToday = reward.isToday;
        const isClaimed = reward.isClaimed;
        const isPast = dayNum < data.todayReward.day;
        const isFuture = dayNum > data.todayReward.day;

        let className = 'cf-daily__day';
        if (isToday) className += ' cf-daily__day--today';
        if (isClaimed) className += ' cf-daily__day--claimed';
        if (isPast) className += ' cf-daily__day--past';
        if (isFuture) className += ' cf-daily__day--future';

        return h('div', { class: className },
            h('div', { class: 'cf-daily__day-num' }, `Day ${dayNum}`),
            h('div', { class: 'cf-daily__day-icon' }, this._getRewardIcon(reward.type)),
            h('div', { class: 'cf-daily__day-label' }, reward.label),
            isClaimed && h('div', { class: 'cf-daily__day-check' }, '✓')
        );
    }

    _getRewardIcon(type) {
        const icons = {
            cash: '💰',
            seeds: '🌱',
            xp: '⭐',
            premium: '🎁'
        };
        return icons[type] || '🎁';
    }

    _renderFlameIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '32');
        svg.setAttribute('height', '32');
        svg.setAttribute('fill', 'var(--color-warning)');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 23c-4.97 0-9-4.03-9-9 0-3.53 2.04-6.58 5-8.03V5c0-1.1.9-2 2-2s2 .9 2 2v.97c2.96 1.45 5 4.5 5 8.03 0 4.97-4.03 9-9 9zm0-16c-.55 0-1 .45-1 1v2.17c-1.76.78-3 2.55-3 4.58 0 2.76 2.24 5 5 5s5-2.24 5-5c0-2.03-1.24-3.8-3-4.58V8c0-.55-.45-1-1-1h-2z');
        svg.appendChild(path);

        return svg;
    }
}

registerComponent('cf-daily-rewards', CFDailyRewards);
export default CFDailyRewards;
