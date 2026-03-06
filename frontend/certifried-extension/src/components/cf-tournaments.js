/**
 * Tournaments Component
 * Weekly competitive events interface
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency, formatTimeRemaining } from '../utils/format.js';

const TYPE_INFO = {
    harvest: { name: 'Harvest', icon: '🌾', description: 'Total harvests during tournament' },
    sales: { name: 'Sales', icon: '💰', description: 'Total cash from sales' },
    quality: { name: 'Quality', icon: '💎', description: 'Average quality of harvests' },
    xp: { name: 'XP', icon: '⭐', description: 'XP earned during tournament' },
    breeding: { name: 'Breeding', icon: '🧬', description: 'Successful breeding operations' }
};

const STATUS_COLORS = {
    upcoming: '#3b82f6',
    active: '#22c55e',
    calculating: '#f59e0b',
    completed: '#6b7280'
};

class CFTournaments extends CFBaseComponent {
    constructor() {
        super();
        this._tournaments = [];
        this._player = { level: 1, cash: 0 };
        this._loading = true;
        this._error = null;
        this._selectedTournament = null;
        this._leaderboard = null;
        this._timerInterval = null;
    }

    async onMount() {
        await this._loadTournaments();

        // Timer for countdowns
        this._timerInterval = setInterval(() => this.render(), 1000);

        // Join tournament
        this.on('click', '.cf-join-tournament', async (e) => {
            const btn = e.target.closest('.cf-join-tournament');
            if (!btn || btn.disabled) return;
            await this._joinTournament(parseInt(btn.dataset.id, 10));
        });

        // View leaderboard
        this.on('click', '.cf-view-leaderboard', async (e) => {
            const btn = e.target.closest('.cf-view-leaderboard');
            if (!btn) return;
            await this._loadLeaderboard(parseInt(btn.dataset.id, 10));
        });

        // Claim reward
        this.on('click', '.cf-claim-reward', async (e) => {
            const btn = e.target.closest('.cf-claim-reward');
            if (!btn) return;
            await this._claimReward(parseInt(btn.dataset.id, 10));
        });

        // Back from leaderboard
        this.on('click', '.cf-back-btn', () => {
            this._selectedTournament = null;
            this._leaderboard = null;
            this.render();
        });
    }

    onUnmount() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
        }
    }

    async _loadTournaments() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._tournaments.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getTournaments();
            if (response.success) {
                this._tournaments = response.tournaments || [];
                this._player = response.player || { level: 1, cash: 0 };
            } else {
                this._error = response.error;
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _loadLeaderboard(tournamentId) {
        try {
            const response = await api.getTournamentLeaderboard(tournamentId);
            if (response.success) {
                this._selectedTournament = response.tournament;
                this._leaderboard = response.leaderboard;
                this._myPosition = response.myPosition;
                this.render();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _joinTournament(tournamentId) {
        try {
            const response = await api.joinTournament(tournamentId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadTournaments();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _claimReward(tournamentId) {
        try {
            const response = await api.claimTournamentReward(tournamentId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadTournaments();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-tournaments';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadTournaments() }, 'Retry')
                )
            );
            return;
        }

        // Leaderboard view
        if (this._selectedTournament && this._leaderboard) {
            this.setContent(this._renderLeaderboardView());
            return;
        }

        // Main tournaments list
        const content = [];

        content.push(
            h('div', { style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Tournaments'),
                h('p', { class: 'text-sm text-muted' }, 'Compete for prizes!')
            )
        );

        // Active tournaments
        const active = this._tournaments.filter(t => t.status === 'active');
        if (active.length > 0) {
            content.push(h('h3', { class: 'text-sm font-semibold text-muted mb-2' }, 'Active'));
            content.push(...active.map(t => this._renderTournament(t)));
        }

        // Upcoming tournaments
        const upcoming = this._tournaments.filter(t => t.status === 'upcoming');
        if (upcoming.length > 0) {
            content.push(h('h3', { class: 'text-sm font-semibold text-muted mt-4 mb-2' }, 'Upcoming'));
            content.push(...upcoming.map(t => this._renderTournament(t)));
        }

        // Completed tournaments
        const completed = this._tournaments.filter(t => t.status === 'completed');
        if (completed.length > 0) {
            content.push(h('h3', { class: 'text-sm font-semibold text-muted mt-4 mb-2' }, 'Recent'));
            content.push(...completed.map(t => this._renderTournament(t)));
        }

        if (this._tournaments.length === 0) {
            content.push(
                h('div', { class: 'cf-empty' },
                    h('p', { class: 'cf-empty__title' }, 'No tournaments'),
                    h('p', { class: 'cf-empty__description' }, 'Check back later for new tournaments!')
                )
            );
        }

        this.setContent(...content);
    }

    _renderTournament(t) {
        const typeInfo = TYPE_INFO[t.type] || { name: t.type, icon: '🏆', description: '' };
        const statusColor = STATUS_COLORS[t.status] || '#666';

        const now = new Date();
        const startsAt = new Date(t.startsAt);
        const endsAt = new Date(t.endsAt);

        let timeDisplay = '';
        if (t.status === 'upcoming') {
            timeDisplay = `Starts in ${formatTimeRemaining(startsAt - now)}`;
        } else if (t.status === 'active') {
            timeDisplay = `Ends in ${formatTimeRemaining(endsAt - now)}`;
        } else {
            timeDisplay = 'Completed';
        }

        return h('div', {
            class: 'cf-card cf-tournament-card',
            style: { marginBottom: 'var(--space-2)', borderLeft: `3px solid ${statusColor}` }
        },
            h('div', { class: 'cf-card__body' },
                // Header
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-2)' } },
                    h('div', {},
                        h('div', { class: 'font-semibold' }, `${typeInfo.icon} ${t.name}`),
                        h('div', { class: 'text-xs text-muted' }, typeInfo.description)
                    ),
                    h('div', {
                        class: 'text-xs',
                        style: { color: statusColor, textTransform: 'capitalize' }
                    }, t.status)
                ),

                // Stats
                h('div', { class: 'text-sm mb-2', style: { display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' } },
                    h('span', { style: { color: 'var(--color-success)' } },
                        `Prize: ${formatCurrency(t.prizePool)}`
                    ),
                    t.entryFee > 0 && h('span', { class: 'text-muted' },
                        `Entry: ${formatCurrency(t.entryFee)}`
                    ),
                    h('span', { class: 'text-muted' },
                        `${t.participantCount}${t.maxParticipants ? `/${t.maxParticipants}` : ''} players`
                    )
                ),

                // Time
                h('div', { class: 'text-xs text-muted mb-2' }, timeDisplay),

                // Player status (if joined)
                t.isJoined && h('div', { class: 'text-sm mb-2', style: { color: 'var(--color-primary)' } },
                    `Your Score: ${t.myScore.toLocaleString()}`,
                    t.myRank && ` (Rank #${t.myRank})`
                ),

                // Requirements
                t.minLevel > 1 && !t.isJoined && h('div', {
                    class: 'text-xs mb-2',
                    style: { color: this._player.level >= t.minLevel ? 'var(--color-success)' : 'var(--color-danger)' }
                },
                    `Requires level ${t.minLevel}`
                ),

                // Actions
                h('div', { style: { display: 'flex', gap: 'var(--space-2)' } },
                    // Join button
                    t.status === 'active' && !t.isJoined && h('button', {
                        class: `cf-btn cf-btn--sm cf-join-tournament ${t.canJoin ? 'cf-btn--primary' : ''}`,
                        dataset: { id: t.id.toString() },
                        disabled: !t.canJoin
                    }, t.canJoin ? 'Join' : (
                        this._player.level < t.minLevel ? 'Level Too Low' :
                        this._player.cash < t.entryFee ? 'Not Enough Cash' :
                        'Cannot Join'
                    )),

                    // Leaderboard button
                    (t.status === 'active' || t.status === 'completed') && h('button', {
                        class: 'cf-btn cf-btn--sm cf-btn--secondary cf-view-leaderboard',
                        dataset: { id: t.id.toString() }
                    }, 'Leaderboard'),

                    // Claim button
                    t.status === 'completed' && t.isJoined && !t.rewardClaimed && t.myRank && t.myRank <= 10 && h('button', {
                        class: 'cf-btn cf-btn--sm cf-btn--success cf-claim-reward',
                        dataset: { id: t.id.toString() }
                    }, 'Claim Prize')
                )
            )
        );
    }

    _renderLeaderboardView() {
        const t = this._selectedTournament;
        const typeInfo = TYPE_INFO[t.type] || { name: t.type, icon: '🏆' };

        return h('div', { class: 'cf-leaderboard-view' },
            // Back button
            h('button', {
                class: 'cf-btn cf-btn--ghost cf-back-btn mb-3',
                style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }
            },
                h('span', {}, '←'),
                h('span', {}, 'Back')
            ),

            // Header
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body' },
                    h('h3', { class: 'font-semibold mb-2' }, `${typeInfo.icon} ${t.name}`),
                    h('div', { class: 'text-sm', style: { display: 'flex', gap: 'var(--space-3)' } },
                        h('span', { style: { color: 'var(--color-success)' } }, `Prize: ${formatCurrency(t.prizePool)}`),
                        h('span', { class: 'text-muted', style: { textTransform: 'capitalize' } }, t.status)
                    )
                )
            ),

            // My position
            this._myPosition && h('div', {
                class: 'cf-card mb-3',
                style: { borderLeft: '3px solid var(--color-primary)' }
            },
                h('div', { class: 'cf-card__body' },
                    h('div', { class: 'text-xs text-muted' }, 'Your Position'),
                    h('div', { class: 'font-semibold' },
                        `#${this._myPosition.rank} - ${this._myPosition.score.toLocaleString()} points`
                    )
                )
            ),

            // Leaderboard
            h('h4', { class: 'text-sm font-semibold text-muted mb-2' }, 'Top Players'),
            ...this._leaderboard.slice(0, 50).map((entry, idx) => {
                const isTop3 = entry.rank <= 3;
                const medals = ['🥇', '🥈', '🥉'];

                return h('div', {
                    class: 'cf-card mb-1',
                    style: {
                        background: isTop3 ? 'var(--bg-secondary)' : 'var(--bg-primary)',
                        padding: 'var(--space-2)'
                    }
                },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                        h('span', { style: { width: '30px', textAlign: 'center', fontWeight: 'bold' } },
                            isTop3 ? medals[entry.rank - 1] : `#${entry.rank}`
                        ),
                        h('div', { style: { flex: 1 } },
                            h('span', { class: 'font-semibold' }, entry.displayName),
                            h('span', { class: 'text-xs text-muted ml-2' }, `Lv.${entry.level}`)
                        ),
                        h('span', { class: 'font-semibold' }, entry.score.toLocaleString()),
                        entry.prizeAmount && h('span', {
                            class: 'text-xs ml-2',
                            style: { color: 'var(--color-success)' }
                        }, formatCurrency(entry.prizeAmount))
                    )
                );
            })
        );
    }
}

registerComponent('cf-tournaments', CFTournaments);
export default CFTournaments;
