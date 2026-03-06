/**
 * CertiFried Extension - Leaderboard Component
 * Shows top players by various metrics
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { api } from '../api/client.js';

class CFLeaderboard extends CFBaseComponent {
    constructor() {
        super();
        this._activeType = 'level';
        this._players = [];
        this._isLoading = true;
        this._platform = 'twitch'; // Will be set from API response
        this._selectedPlayer = null; // For profile modal
    }

    onMount() {
        this._loadLeaderboard();

        this.on('click', '.cf-leaderboard__tab', (e) => {
            const tab = e.target.closest('.cf-leaderboard__tab');
            if (!tab) return;
            this._activeType = tab.dataset.type;
            this._loadLeaderboard();
        });

        // View profile click
        this.on('click', '.cf-leaderboard__profile-btn', async (e) => {
            const btn = e.target.closest('.cf-leaderboard__profile-btn');
            if (!btn) return;
            const playerId = parseInt(btn.dataset.playerId, 10);
            await this._viewProfile(playerId);
        });

        // Close profile modal
        this.on('click', '.cf-profile-overlay', (e) => {
            if (e.target.classList.contains('cf-profile-overlay')) {
                this._selectedPlayer = null;
                this.render();
            }
        });

        this.on('click', '.cf-profile__close', () => {
            this._selectedPlayer = null;
            this.render();
        });
    }

    async _viewProfile(playerId) {
        try {
            const data = await api.getProfile(playerId);
            this._selectedPlayer = data.player;
            this.render();
        } catch (error) {
            console.error('Failed to load profile:', error);
            this.emit('notification', {
                type: 'error',
                message: 'Failed to load profile'
            });
        }
    }

    async _loadLeaderboard() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._players.length === 0;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            // Map frontend type names to backend type names
            const typeMap = { currency: 'cash', level: 'level', prestige: 'prestige' };
            const backendType = typeMap[this._activeType] || this._activeType;

            const data = await api.getLeaderboard(backendType, 25);
            this._players = data.leaderboard || data.players || data || [];
            this._playerRank = data.playerRank;
            this._platform = data.platform || 'twitch'; // Platform the leaderboard is filtered by

        } catch (error) {
            console.error('Failed to load leaderboard:', error);
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    render() {
        const player = this.getState('player') || {};
        const platformLabel = this._platform === 'kick' ? 'Kick' : 'Twitch';

        this.className = 'cf-leaderboard';
        this.setContent(
            // Platform indicator
            h('div', {
                class: 'cf-leaderboard__platform text-xs text-center mb-2',
                style: {
                    color: this._platform === 'kick' ? '#53fc18' : '#9146ff',
                    fontWeight: 'bold'
                }
            }, `${platformLabel} Leaderboard`),

            // Type tabs
            h('div', { class: 'cf-tabs mb-3' },
                this._renderTab('level', 'Level'),
                this._renderTab('currency', 'Wealth'),
                this._renderTab('prestige', 'Prestige')
            ),

            // Loading
            this._isLoading && h('div', { class: 'cf-loading' },
                h('div', { class: 'cf-spinner' })
            ),

            // Empty state
            !this._isLoading && this._players.length === 0 && h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No players yet'),
                h('p', { class: 'cf-empty__description' }, 'Be the first to climb the ranks!')
            ),

            // Player list
            !this._isLoading && this._players.length > 0 && h('div', { class: 'cf-leaderboard__list' },
                ...this._players.map((p, i) => this._renderPlayer(p, i, player.id))
            ),

            // Profile modal
            this._selectedPlayer && this._renderProfileModal()
        );
    }

    _renderProfileModal() {
        const p = this._selectedPlayer;
        return h('div', { class: 'cf-profile-overlay' },
            h('div', { class: 'cf-profile-modal' },
                // Header
                h('div', { class: 'cf-profile-modal__header' },
                    h('div', {
                        class: 'cf-avatar cf-avatar--lg',
                        style: {
                            background: this._getAvatarColor(p.displayName || 'U'),
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'white',
                            fontSize: '20px',
                            fontWeight: 'bold'
                        }
                    }, (p.displayName || 'U')[0].toUpperCase()),
                    h('div', { class: 'cf-profile-modal__title' },
                        h('h3', {}, p.displayName),
                        h('div', { class: 'text-sm text-muted' }, `Level ${p.level}` + (p.prestigeLevel > 0 ? ` • P${p.prestigeLevel}` : ''))
                    ),
                    h('button', { class: 'cf-profile__close' }, '\u00D7')
                ),

                // Stats grid
                h('div', { class: 'cf-profile-modal__stats' },
                    this._renderProfileStat('Lifetime Earnings', formatCurrency(p.lifetimeEarnings || 0)),
                    this._renderProfileStat('Total Sales', formatCurrency(p.lifetimeSales || 0)),
                    this._renderProfileStat('Achievements', p.achievements || 0),
                    this._renderProfileStat('Strains Discovered', p.strainsDiscovered || 0),
                    this._renderProfileStat('Strains Created', p.strainsCreated || 0),
                    this._renderProfileStat('Facility', p.facilityName || 'Basic Grow Op')
                ),

                // Join date
                p.joinedAt && h('div', { class: 'cf-profile-modal__footer text-xs text-muted text-center' },
                    `Joined ${new Date(p.joinedAt).toLocaleDateString()}`
                )
            )
        );
    }

    _renderProfileStat(label, value) {
        return h('div', { class: 'cf-profile-stat' },
            h('div', { class: 'cf-profile-stat__value' }, value.toString()),
            h('div', { class: 'cf-profile-stat__label text-xs text-muted' }, label)
        );
    }

    _renderTab(type, label) {
        return h('button', {
            class: `cf-tab cf-leaderboard__tab ${this._activeType === type ? 'cf-tab--active' : ''}`,
            dataset: { type }
        }, label);
    }

    _renderPlayer(player, index, currentPlayerId) {
        // Backend returns camelCase (displayName, prestigeLevel) but also snake_case in some fields
        const displayName = player.displayName || player.display_name || 'Unknown';
        const prestigeLevel = player.prestigeLevel ?? player.prestige_level ?? 0;
        const isCurrentPlayer = player.isYou || player.id === currentPlayerId;
        const rank = player.rank || (index + 1);

        let medal = '';
        if (rank === 1) medal = '🥇';
        else if (rank === 2) medal = '🥈';
        else if (rank === 3) medal = '🥉';

        const statValue = this._getStatValue(player);

        return h('div', {
            class: `cf-leaderboard__player ${isCurrentPlayer ? 'cf-leaderboard__player--current' : ''}`,
            style: {
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                padding: 'var(--space-2) var(--space-3)',
                background: isCurrentPlayer ? 'rgba(34, 197, 94, 0.1)' : 'var(--bg-secondary)',
                border: isCurrentPlayer ? '1px solid var(--color-primary-600)' : '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--space-2)'
            }
        },
            // Rank
            h('div', {
                style: {
                    width: '32px',
                    textAlign: 'center',
                    fontWeight: 'var(--font-weight-bold)',
                    color: rank <= 3 ? 'var(--color-accent-500)' : 'var(--text-muted)'
                }
            }, medal || `#${rank}`),

            // Avatar placeholder
            h('div', {
                class: 'cf-avatar cf-avatar--sm',
                style: {
                    background: this._getAvatarColor(displayName),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    fontSize: '10px',
                    fontWeight: 'bold'
                }
            }, displayName[0].toUpperCase()),

            // Name
            h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', {
                    class: 'font-semibold',
                    style: {
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                    }
                }, displayName),
                prestigeLevel > 0 && h('div', { class: 'text-xs text-muted' },
                    `Prestige ${prestigeLevel}`
                )
            ),

            // Stat value
            h('div', {
                class: 'font-bold',
                style: { color: 'var(--color-primary-400)' }
            }, statValue),

            // Profile button
            !isCurrentPlayer && h('button', {
                class: 'cf-leaderboard__profile-btn',
                dataset: { playerId: player.id.toString() },
                style: {
                    padding: '4px 8px',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--text-muted)',
                    cursor: 'pointer'
                }
            }, 'View')
        );
    }

    _getStatValue(player) {
        const prestigeLevel = player.prestigeLevel ?? player.prestige_level ?? 0;
        const cash = player.cash ?? player.currency ?? 0;

        switch (this._activeType) {
            case 'level':
                return `Lv.${player.level}`;
            case 'currency':
                return formatCurrency(cash, true);
            case 'prestige':
                return `P${prestigeLevel}`;
            default:
                return `Lv.${player.level}`;
        }
    }

    _getAvatarColor(name) {
        // Generate consistent color from name
        const colors = [
            '#ef4444', '#f97316', '#f59e0b', '#84cc16',
            '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
            '#6366f1', '#8b5cf6', '#a855f7', '#d946ef'
        ];

        const safeName = name || 'U';
        let hash = 0;
        for (let i = 0; i < safeName.length; i++) {
            hash = safeName.charCodeAt(i) + ((hash << 5) - hash);
        }

        return colors[Math.abs(hash) % colors.length];
    }
}

registerComponent('cf-leaderboard', CFLeaderboard);
export default CFLeaderboard;
