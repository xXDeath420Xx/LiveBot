/**
 * CertiFried Extension - Bosses Component
 * Challenge encounters with time-limited goals
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatNumber } from '../utils/format.js';
import { api } from '../api/client.js';

class CFBosses extends CFBaseComponent {
    constructor() {
        super();
        this._bossesData = null;
        this._loading = true;
        this._timerInterval = null;
    }

    _setupSubscriptions() {
        this.subscribe('player');
    }

    async onMount() {
        await this._loadData();

        // Start timer if there's an active encounter
        this._startTimer();

        // Challenge boss
        this.on('click', '.cf-boss-challenge', async (e) => {
            const btn = e.target.closest('.cf-boss-challenge');
            const bossId = parseInt(btn.dataset.bossId, 10);

            try {
                btn.disabled = true;
                btn.textContent = 'Starting...';

                const result = await api.challengeBoss(bossId);
                if (result.success) {
                    this.emit('notification', {
                        type: 'success',
                        message: result.message
                    });
                    await this._loadData();
                    this._startTimer();
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
                btn.disabled = false;
                btn.textContent = 'Challenge';
            }
        });

        // Claim reward
        this.on('click', '.cf-boss-claim', async (e) => {
            const btn = e.target.closest('.cf-boss-claim');
            const bossId = parseInt(btn.dataset.bossId, 10);

            try {
                btn.disabled = true;
                btn.textContent = 'Claiming...';

                const result = await api.claimBossReward(bossId);
                if (result.success) {
                    this.emit('notification', {
                        type: 'success',
                        message: result.message
                    });
                    await this._loadData();
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
                btn.disabled = false;
                btn.textContent = 'Claim';
            }
        });

        // Abandon encounter
        this.on('click', '.cf-boss-abandon', async () => {
            if (!confirm('Are you sure you want to abandon this challenge?')) return;

            try {
                const result = await api.abandonBossEncounter();
                if (result.success) {
                    this.emit('notification', {
                        type: 'warning',
                        message: result.message
                    });
                    this._stopTimer();
                    await this._loadData();
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
            }
        });
    }

    onUnmount() {
        this._stopTimer();
    }

    _startTimer() {
        this._stopTimer();
        this._timerInterval = setInterval(() => {
            if (this._bossesData?.activeEncounter) {
                this.render();
            }
        }, 1000);
    }

    _stopTimer() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
            this._timerInterval = null;
        }
    }

    async _loadData() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = !this._bossesData;

        if (isFirstLoad) {
            this._loading = true;
            this.render();
        }

        try {
            this._bossesData = await api.getBosses();
        } catch (error) {
            console.error('[CFBosses] Load error:', error);
        } finally {
            this._loading = false;
            this.scheduleRender();
        }
    }

    render() {
        this.className = 'cf-bosses';

        if (this._loading) {
            this.setContent(
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' }),
                    h('p', {}, 'Loading boss encounters...')
                )
            );
            return;
        }

        if (!this._bossesData) {
            this.setContent(h('div', { class: 'cf-error' }, 'Failed to load bosses'));
            return;
        }

        const { bosses, activeEncounter, playerLevel } = this._bossesData;

        this.setContent(
            h('div', { class: 'cf-bosses__header', style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Boss Encounters'),
                h('p', { class: 'text-sm text-muted' }, 'Challenge bosses to earn exclusive rewards')
            ),

            // Active encounter banner
            activeEncounter && this._renderActiveEncounter(activeEncounter),

            // Boss list
            h('div', { class: 'cf-bosses-list' },
                ...bosses.map(boss => this._renderBossCard(boss, activeEncounter, playerLevel))
            )
        );
    }

    _renderActiveEncounter(encounter) {
        const now = new Date();
        const endsAt = new Date(encounter.endsAt);
        const timeLeftMs = Math.max(0, endsAt - now);
        const minutes = Math.floor(timeLeftMs / 60000);
        const seconds = Math.floor((timeLeftMs % 60000) / 1000);
        const progress = Math.round((encounter.currentScore / encounter.goal) * 100);
        const isExpired = timeLeftMs <= 0;

        return h('div', {
            class: 'cf-card cf-active-encounter mb-4',
            style: {
                background: 'linear-gradient(135deg, var(--bg-tertiary) 0%, var(--bg-secondary) 100%)',
                border: '2px solid var(--color-warning)'
            }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-3)' } },
                    h('div', {},
                        h('div', { class: 'text-xs text-muted' }, 'ACTIVE CHALLENGE'),
                        h('h3', { class: 'font-semibold' }, encounter.bossName)
                    ),
                    h('div', {
                        class: 'text-lg font-bold',
                        style: { color: isExpired ? 'var(--color-danger)' : 'var(--color-warning)' }
                    }, isExpired ? 'TIME UP!' : `${minutes}:${seconds.toString().padStart(2, '0')}`)
                ),

                // Progress bar
                h('div', { style: { marginBottom: 'var(--space-3)' } },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)' } },
                        h('span', { class: 'text-sm' }, `Progress: ${encounter.currentScore}/${encounter.goal}`),
                        h('span', { class: 'text-sm font-semibold' }, `${progress}%`)
                    ),
                    h('div', { class: 'cf-progress', style: { height: '12px', background: 'var(--bg-primary)', borderRadius: '6px', overflow: 'hidden' } },
                        h('div', {
                            style: {
                                width: `${Math.min(100, progress)}%`,
                                height: '100%',
                                background: progress >= 100 ? 'var(--color-success)' : 'var(--color-warning)',
                                transition: 'width 0.5s'
                            }
                        })
                    )
                ),

                // Actions
                h('div', { style: { display: 'flex', gap: 'var(--space-2)' } },
                    progress >= 100 && h('button', {
                        class: 'cf-btn cf-btn--success cf-boss-claim',
                        dataset: { bossId: encounter.bossId }
                    }, '🎉 Claim Reward'),
                    h('button', { class: 'cf-btn cf-btn--ghost cf-boss-abandon' }, 'Abandon')
                )
            )
        );
    }

    _renderBossCard(boss, activeEncounter, playerLevel) {
        const isActive = activeEncounter?.bossId === boss.id;
        const isLocked = !boss.isUnlocked;
        const onCooldown = boss.cooldownEnds !== null && !isActive;
        const hasVictory = boss.lastResult?.status === 'victory';
        const canClaim = hasVictory && boss.canChallenge;

        // Difficulty indicator
        const difficultyColors = {
            1: 'var(--color-success)',
            2: 'var(--color-success)',
            3: 'var(--color-warning)',
            4: 'var(--color-warning)',
            5: 'var(--color-danger)'
        };

        return h('div', {
            class: `cf-card mb-3 ${isLocked ? 'cf-locked' : ''} ${isActive ? 'cf-active' : ''}`,
            style: {
                opacity: isLocked ? 0.5 : 1,
                borderColor: isActive ? 'var(--color-warning)' : 'var(--border-primary)'
            }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', gap: 'var(--space-3)' } },
                    // Icon
                    h('div', {
                        style: {
                            width: '60px', height: '60px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-md)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '32px'
                        }
                    }, boss.icon || '👹'),

                    // Info
                    h('div', { style: { flex: 1 } },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                            h('h3', { class: 'font-semibold' }, boss.name),
                            h('span', {
                                style: {
                                    fontSize: '10px',
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    background: difficultyColors[boss.difficulty] || 'var(--bg-tertiary)',
                                    color: 'white'
                                }
                            }, `★ ${'★'.repeat(boss.difficulty - 1)}`)
                        ),
                        h('p', { class: 'text-xs text-muted mb-2' }, boss.description),

                        // Challenge info
                        h('div', { class: 'text-xs mb-2', style: { display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' } },
                            h('span', {}, `🎯 ${this._getChallengeTypeLabel(boss.challengeType)}: ${formatNumber(boss.challengeGoal)}`),
                            h('span', {}, `⏱️ ${boss.timeLimitMinutes}min`)
                        ),

                        // Rewards
                        h('div', { class: 'text-xs', style: { color: 'var(--color-success)' } },
                            `💰 ${formatCurrency(boss.rewardCash)} + ${boss.rewardXp} XP`,
                            boss.rewardItem && ` + ${boss.rewardItem}`
                        ),

                        // Last result
                        boss.lastResult && h('div', { class: 'text-xs mt-2', style: { color: boss.lastResult.status === 'victory' ? 'var(--color-success)' : 'var(--text-muted)' } },
                            `Last: ${boss.lastResult.status} (${boss.lastResult.score} pts)`
                        ),

                        // Lock/cooldown info
                        isLocked && h('div', { class: 'text-xs mt-2', style: { color: 'var(--color-warning)' } },
                            `🔒 Requires level ${boss.minLevel}`
                        ),
                        onCooldown && h('div', { class: 'text-xs mt-2', style: { color: 'var(--color-warning)' } },
                            `⏳ Available ${this._formatCooldown(boss.cooldownEnds)}`
                        )
                    ),

                    // Action button
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', justifyContent: 'center' } },
                        !isActive && !canClaim && h('button', {
                            class: 'cf-btn cf-btn--primary cf-boss-challenge',
                            dataset: { bossId: boss.id },
                            disabled: !boss.canChallenge
                        }, boss.canChallenge ? 'Challenge' : (isLocked ? 'Locked' : 'Wait')),

                        canClaim && h('button', {
                            class: 'cf-btn cf-btn--success cf-boss-claim',
                            dataset: { bossId: boss.id }
                        }, 'Claim'),

                        isActive && h('span', {
                            class: 'text-xs',
                            style: { color: 'var(--color-warning)', textAlign: 'center' }
                        }, 'In Progress')
                    )
                )
            )
        );
    }

    _getChallengeTypeLabel(type) {
        const labels = {
            'harvest': 'Harvest',
            'sell': 'Sell value',
            'grow': 'Plants grown',
            'breed': 'Breeds',
            'quality': 'Quality avg',
            'cash_earned': 'Cash earned'
        };
        return labels[type] || type;
    }

    _formatCooldown(cooldownEnds) {
        if (!cooldownEnds) return '';
        const now = new Date();
        const end = new Date(cooldownEnds);
        const diffMs = end - now;

        if (diffMs <= 0) return 'now';

        const hours = Math.floor(diffMs / (60 * 60 * 1000));
        if (hours >= 24) {
            const days = Math.floor(hours / 24);
            return `in ${days}d`;
        }
        if (hours >= 1) {
            return `in ${hours}h`;
        }
        const minutes = Math.floor(diffMs / 60000);
        return `in ${minutes}m`;
    }
}

registerComponent('cf-bosses', CFBosses);
export default CFBosses;
