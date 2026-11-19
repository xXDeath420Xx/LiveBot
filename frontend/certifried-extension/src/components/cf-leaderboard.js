/**
 * CertiFried Extension - Leaderboard Component
 * Shows top players by various metrics
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

const PLATFORM_LABEL = { twitch: 'Twitch', kick: 'Kick', discord: 'Discord' };

function daysLeft(endsAt) {
    const ms = new Date(endsAt).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'ending now';
    const days = Math.floor(ms / 86400000);
    if (days >= 1) return `${days} day${days === 1 ? '' : 's'} left`;
    const hours = Math.max(1, Math.floor(ms / 3600000));
    return `${hours} hour${hours === 1 ? '' : 's'} left`;
}

class CFLeaderboard extends CFBaseComponent {
    constructor() {
        super();
        // The season board is the default: it is the one that resets and pays out (H-408)
        this._activeType = store.get('ui.leaderboardType') || 'season';
        this._seasons = null;
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
        if (this._activeType === 'season') {
            if (!this._seasons) {
                this._isLoading = true;
                this.render();
            }
            try {
                this._seasons = await api.getSeasons(25);
            } catch (error) {
                console.error('Failed to load seasons:', error);
                this._seasons = this._seasons || { current: null, last: null };
            } finally {
                this._isLoading = false;
                this.scheduleRender();
            }
            return;
        }

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

        this.className = 'cf-leaderboard';
        if (this._activeType === 'season') {
            this.setContent(
                this._renderTabs(),
                this._isLoading && h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })),
                !this._isLoading && this._renderSeasons()
            );
            return;
        }
        this.setContent(
            // Type tabs (one board for everyone, whatever they signed in with)
            this._renderTabs(),

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

    _renderTabs() {
        return h('div', { class: 'cf-tabs mb-3' },
            this._renderTab('season', 'Season'),
            this._renderTab('level', 'Level'),
            this._renderTab('currency', 'Wealth'),
            this._renderTab('prestige', 'Prestige')
        );
    }

    _renderSeasons() {
        const { current, last } = this._seasons || {};
        const blocks = [];
        if (current) {
            blocks.push(h('div', { class: 'cf-season' },
                h('div', { class: 'cf-season__head' },
                    h('span', { class: 'cf-season__name' }, current.name),
                    h('span', { class: 'cf-season__meta text-xs text-muted' }, daysLeft(current.endsAt))
                ),
                h('p', { class: 'cf-season__note text-xs text-muted' },
                    'Ranked by XP earned this season. Top 10 are paid when it ends.'),
                current.me
                    ? h('p', { class: 'cf-season__me text-sm' }, `You are #${current.me.rank} with ${current.me.seasonXp.toLocaleString()} XP`)
                    : h('p', { class: 'cf-season__me text-sm text-muted' }, 'Earn XP (grow, sell, finish quests) to get on the board.'),
                current.standings?.length
                    ? h('div', { class: 'cf-leaderboard__list' }, ...current.standings.map(p => this._renderSeasonRow(p, `${p.seasonXp.toLocaleString()} XP`)))
                    : h('div', { class: 'cf-empty' }, h('p', { class: 'cf-empty__description' }, 'Nobody has earned season XP yet.')),
                this._renderRewards(current.rewards)
            ));
        } else {
            blocks.push(h('div', { class: 'cf-empty' }, h('p', { class: 'cf-empty__description' }, 'No season is running right now.')));
        }
        if (last) {
            blocks.push(h('div', { class: 'cf-season cf-season--final' },
                h('div', { class: 'cf-season__head' },
                    h('span', { class: 'cf-season__name' }, `${last.name}: final standings`),
                    h('span', { class: 'cf-season__meta text-xs text-muted' }, `ended ${new Date(last.endsAt).toLocaleDateString()}`)
                ),
                last.standings?.length
                    ? h('div', { class: 'cf-leaderboard__list' }, ...last.standings.map(p => this._renderSeasonRow(p, this._rewardText(p.reward) || formatCurrency(p.seasonEarnings, true))))
                    : h('p', { class: 'text-xs text-muted' }, 'Nobody was ranked.')
            ));
        }
        return h('div', { class: 'cf-seasons' }, ...blocks);
    }

    _rewardText(reward) {
        if (!reward) return '';
        const parts = [];
        if (reward.cash) parts.push(formatCurrency(reward.cash, true));
        if (reward.prestige_tokens) parts.push(`${reward.prestige_tokens} PT`);
        return parts.join(' + ');
    }

    _renderRewards(rewards) {
        if (!rewards?.ranks?.length) return null;
        const rows = rewards.ranks.map(r => h('li', {},
            `${r.from === r.to ? `#${r.from}` : `#${r.from}-${r.to}`}: ${this._rewardText(r)}`));
        if (rewards.participation?.cash || rewards.participation?.prestige_tokens) {
            rows.push(h('li', {}, `Everyone else on the board: ${this._rewardText(rewards.participation)}`));
        }
        return h('details', { class: 'cf-season__rewards text-xs' },
            h('summary', {}, 'Season rewards'),
            h('ul', {}, ...rows));
    }

    _renderSeasonRow(p, value) {
        const isYou = !!p.isYou;
        const where = PLATFORM_LABEL[p.platform] || '';
        return h('div', { class: `cf-leaderboard__player cf-season__row ${isYou ? 'cf-leaderboard__player--current' : ''}` },
            h('span', { class: 'cf-season__rank' }, `#${p.rank}`),
            h('span', { class: 'cf-season__who' },
                h('span', { class: 'cf-season__player' }, p.displayName || 'Unknown'),
                where && h('span', { class: 'cf-season__platform text-xs text-muted' }, where)
            ),
            h('span', { class: 'cf-season__value' }, value)
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
                h('div', { class: 'text-xs text-muted' },
                    [PLATFORM_LABEL[player.platform], prestigeLevel > 0 ? `Prestige ${prestigeLevel}` : null].filter(Boolean).join(' · ')
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
