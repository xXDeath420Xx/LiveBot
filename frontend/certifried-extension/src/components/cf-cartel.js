/**
 * Cartel Component
 * Guild/clan management interface
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency } from '../utils/format.js';

// Cartel upgrade icons
const UPGRADE_ICONS = {
    recruitment_office: '👥',
    intelligence_network: '🕵️',
    cartel_vault: '🏦',
    supply_network: '🚚',
    training_facility: '🎓',
    smuggling_routes: '🛣️',
    war_bunker: '🏰',
    territory_flags: '🚩',
    default: '⚙️'
};

class CFCartel extends CFBaseComponent {
    constructor() {
        super();
        this._inCartel = false;
        this._cartel = null;
        this._myRole = null;
        this._myContribution = { cash: 0, xp: 0, wars: 0 };
        this._members = [];
        this._upgrades = [];
        this._territories = [];
        this._availableCartels = [];
        this._pendingInvites = [];
        this._loading = true;
        this._error = null;
        this._activeTab = 'info';
        this._showCreateModal = false;
        this._showContributeModal = false;
        this._contributeAmount = 0;
    }

    async onMount() {
        await this._loadCartel();

        // Tab clicks
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        // Create cartel
        this.on('click', '.cf-create-cartel-btn', () => {
            this._showCreateModal = true;
            this.render();
        });

        this.on('click', '.cf-create-submit', async (e) => {
            await this._createCartel();
        });

        // Join cartel
        this.on('click', '.cf-join-cartel', async (e) => {
            const btn = e.target.closest('.cf-join-cartel');
            if (!btn) return;
            await this._joinCartel(parseInt(btn.dataset.id, 10));
        });

        // Accept invite
        this.on('click', '.cf-accept-invite', async (e) => {
            const btn = e.target.closest('.cf-accept-invite');
            if (!btn) return;
            await this._acceptInvite(parseInt(btn.dataset.id, 10));
        });

        // Leave cartel
        this.on('click', '.cf-leave-cartel', async () => {
            if (confirm('Are you sure you want to leave the cartel?')) {
                await this._leaveCartel();
            }
        });

        // Contribute
        this.on('click', '.cf-contribute-btn', () => {
            this._showContributeModal = true;
            this._contributeAmount = 0;
            this.render();
        });

        this.on('click', '.cf-contribute-submit', async () => {
            await this._contribute();
        });

        // Purchase upgrade
        this.on('click', '.cf-buy-upgrade', async (e) => {
            const btn = e.target.closest('.cf-buy-upgrade');
            if (!btn || btn.disabled) return;
            await this._buyUpgrade(parseInt(btn.dataset.id, 10));
        });

        // Close modals
        this.on('click', '.cf-modal-backdrop, .cf-modal-close', (e) => {
            if (e.target.classList.contains('cf-modal-backdrop') || e.target.classList.contains('cf-modal-close')) {
                this._showCreateModal = false;
                this._showContributeModal = false;
                this.render();
            }
        });

        // Input handlers
        this.on('input', '.cf-contribute-input', (e) => {
            this._contributeAmount = parseInt(e.target.value, 10) || 0;
        });
    }

    async _loadCartel() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = !this._cartel && this._availableCartels.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getCartel();
            if (response.success) {
                this._inCartel = response.inCartel;
                if (response.inCartel) {
                    this._cartel = response.cartel;
                    this._myRole = response.myRole;
                    this._myContribution = response.myContribution;
                    this._members = response.members || [];
                    this._upgrades = response.upgrades || [];
                    this._territories = response.territories || [];
                } else {
                    this._availableCartels = response.availableCartels || [];
                    this._pendingInvites = response.pendingInvites || [];
                }
            } else {
                this._error = response.error;
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _createCartel() {
        const nameInput = this.querySelector('.cf-cartel-name');
        const tagInput = this.querySelector('.cf-cartel-tag');
        const descInput = this.querySelector('.cf-cartel-desc');

        const name = nameInput?.value?.trim();
        const tag = tagInput?.value?.trim();
        const description = descInput?.value?.trim();

        if (!name || !tag) {
            this.emit('notification', { type: 'error', message: 'Name and tag required' });
            return;
        }

        try {
            const response = await api.createCartel(name, tag, description);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                this._showCreateModal = false;
                await this._loadCartel();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _joinCartel(cartelId) {
        try {
            const response = await api.joinCartel(cartelId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadCartel();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _acceptInvite(inviteId) {
        try {
            const response = await api.joinCartel(null, inviteId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadCartel();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _leaveCartel() {
        try {
            const response = await api.leaveCartel();
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadCartel();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _contribute() {
        if (this._contributeAmount <= 0) {
            this.emit('notification', { type: 'error', message: 'Enter a valid amount' });
            return;
        }

        try {
            const response = await api.contributeToCartel(this._contributeAmount);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                this._showContributeModal = false;
                await this._loadCartel();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _buyUpgrade(upgradeId) {
        try {
            const response = await api.purchaseCartelUpgrade(upgradeId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadCartel();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-cartel';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadCartel() }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        if (this._inCartel) {
            content.push(this._renderCartelView());
        } else {
            content.push(this._renderJoinView());
        }

        // Modals
        if (this._showCreateModal) {
            content.push(this._renderCreateModal());
        }
        if (this._showContributeModal) {
            content.push(this._renderContributeModal());
        }

        this.setContent(...content);
    }

    _renderCartelView() {
        const c = this._cartel;

        return h('div', { class: 'cf-cartel-view' },
            // Header
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                        h('span', { style: { fontSize: '2rem' } }, c.icon),
                        h('div', { style: { flex: 1 } },
                            h('div', { class: 'font-semibold' }, `${c.name} [${c.tag}]`),
                            h('div', { class: 'text-sm text-muted' }, `Level ${c.level} | ${this._members.length}/${c.maxMembers} members`)
                        ),
                        h('div', { class: 'text-right' },
                            h('div', { class: 'text-xs text-muted' }, 'Your Role'),
                            h('div', { class: 'font-semibold', style: { textTransform: 'capitalize' } }, this._myRole)
                        )
                    ),

                    // XP progress
                    h('div', { class: 'mt-3' },
                        h('div', { class: 'text-xs text-muted mb-1' }, `XP: ${c.xp.toLocaleString()} / ${c.xpToNextLevel.toLocaleString()}`),
                        h('div', { class: 'cf-progress' },
                            h('div', {
                                class: 'cf-progress__bar',
                                style: { width: `${Math.min(100, (c.xp / c.xpToNextLevel) * 100)}%` }
                            })
                        )
                    ),

                    // Bank
                    h('div', { class: 'mt-3', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                        h('div', {},
                            h('span', { class: 'text-xs text-muted' }, 'Cartel Bank: '),
                            h('span', { class: 'font-semibold', style: { color: 'var(--color-success)' } },
                                formatCurrency(c.cashBank)
                            )
                        ),
                        h('button', { class: 'cf-btn cf-btn--sm cf-btn--primary cf-contribute-btn' }, 'Contribute')
                    )
                )
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'info' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'info' }
                }, 'Info'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'members' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'members' }
                }, `Members (${this._members.length})`),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'upgrades' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'upgrades' }
                }, 'Upgrades')
            ),

            // Tab content
            this._activeTab === 'info' && this._renderInfoTab(),
            this._activeTab === 'members' && this._renderMembersTab(),
            this._activeTab === 'upgrades' && this._renderUpgradesTab(),

            // Leave button
            this._myRole !== 'leader' && h('button', {
                class: 'cf-btn cf-btn--ghost cf-leave-cartel mt-4',
                style: { color: 'var(--color-danger)' }
            }, 'Leave Cartel')
        );
    }

    _renderInfoTab() {
        const c = this._cartel;

        return h('div', {},
            // Description
            c.description && h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body' },
                    h('div', { class: 'text-xs text-muted mb-1' }, 'Description'),
                    h('p', { class: 'text-sm' }, c.description)
                )
            ),

            // My contribution
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Your Contribution')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', gap: 'var(--space-4)' } },
                        h('div', {},
                            h('div', { class: 'text-xs text-muted' }, 'Cash'),
                            h('div', { class: 'font-semibold' }, formatCurrency(this._myContribution.cash))
                        ),
                        h('div', {},
                            h('div', { class: 'text-xs text-muted' }, 'XP'),
                            h('div', { class: 'font-semibold' }, this._myContribution.xp.toLocaleString())
                        ),
                        h('div', {},
                            h('div', { class: 'text-xs text-muted' }, 'Wars'),
                            h('div', { class: 'font-semibold' }, this._myContribution.wars.toLocaleString())
                        )
                    )
                )
            ),

            // Territories
            this._territories.length > 0 && h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Controlled Territories')
                ),
                h('div', { class: 'cf-card__body' },
                    ...this._territories.map(t =>
                        h('div', { class: 'text-sm mb-1' },
                            h('span', { class: 'font-semibold' }, t.name),
                            h('span', { class: 'text-muted' }, ` (+${Math.round(t.bonusValue * 100)}% ${t.bonusType})`)
                        )
                    )
                )
            )
        );
    }

    _renderMembersTab() {
        return h('div', { class: 'cf-members-list' },
            ...this._members.map(m =>
                h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                            h('div', {},
                                h('div', { class: 'font-semibold' }, m.displayName),
                                h('div', { class: 'text-xs text-muted' },
                                    `Level ${m.level} | ${m.role}`
                                )
                            ),
                            h('div', { class: 'text-right text-xs text-muted' },
                                `${formatCurrency(m.contributionCash)} contributed`
                            )
                        )
                    )
                )
            )
        );
    }

    _renderUpgradesTab() {
        return h('div', { class: 'cf-upgrades-list' },
            ...this._upgrades.map(u => {
                const canAfford = this._cartel.cashBank >= u.nextCost;
                const isMaxed = u.currentLevel >= u.maxLevel;
                const currentBonus = u.effectValuePerLevel * u.currentLevel;
                const isOfficer = this._myRole !== 'member';
                // Get icon from upgrade data, or fallback to mapping by upgradeKey/name
                const icon = u.icon || UPGRADE_ICONS[u.upgradeKey] || UPGRADE_ICONS[u.key] || this._getUpgradeIcon(u.name) || UPGRADE_ICONS.default;

                return h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                            h('div', { style: { flex: 1 } },
                                h('div', { class: 'font-semibold' }, `${icon} ${u.name}`),
                                h('div', { class: 'text-xs text-muted' }, u.description),
                                h('div', { class: 'text-xs mt-1' },
                                    `Level ${u.currentLevel}/${u.maxLevel}`,
                                    currentBonus > 0 && ` (+${u.effectType.includes('capacity') || u.effectType.includes('members')
                                        ? Math.floor(currentBonus)
                                        : Math.round(currentBonus * 100) + '%'})`
                                )
                            ),
                            !isMaxed && isOfficer && h('button', {
                                class: `cf-btn cf-btn--sm cf-buy-upgrade ${canAfford ? 'cf-btn--primary' : ''}`,
                                dataset: { id: u.id.toString() },
                                disabled: !canAfford
                            }, formatCurrency(u.nextCost)),
                            isMaxed && h('span', { class: 'text-xs text-muted' }, 'MAX')
                        )
                    )
                );
            })
        );
    }

    _getUpgradeIcon(name) {
        if (!name) return null;
        const lowerName = name.toLowerCase();
        if (lowerName.includes('recruit')) return '👥';
        if (lowerName.includes('intelligen') || lowerName.includes('spy')) return '🕵️';
        if (lowerName.includes('vault') || lowerName.includes('bank')) return '🏦';
        if (lowerName.includes('supply') || lowerName.includes('logistics')) return '🚚';
        if (lowerName.includes('train') || lowerName.includes('facility')) return '🎓';
        if (lowerName.includes('smuggl') || lowerName.includes('route')) return '🛣️';
        if (lowerName.includes('bunker') || lowerName.includes('war') || lowerName.includes('defense')) return '🏰';
        if (lowerName.includes('territor') || lowerName.includes('flag')) return '🚩';
        return null;
    }

    _renderJoinView() {
        return h('div', { class: 'cf-join-view' },
            h('h2', { class: 'cf-section__title mb-3' }, 'Cartels'),
            h('p', { class: 'text-sm text-muted mb-4' },
                'Join a cartel for shared bonuses and turf wars!'
            ),

            // Pending invites
            this._pendingInvites.length > 0 && h('div', { class: 'mb-4' },
                h('h3', { class: 'text-sm font-semibold mb-2' }, 'Pending Invites'),
                ...this._pendingInvites.map(inv =>
                    h('div', { class: 'cf-card mb-2' },
                        h('div', { class: 'cf-card__body' },
                            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                                h('div', {},
                                    h('div', { class: 'font-semibold' }, `${inv.cartelName} [${inv.tag}]`),
                                    h('div', { class: 'text-xs text-muted' }, `Level ${inv.level}`)
                                ),
                                h('button', {
                                    class: 'cf-btn cf-btn--sm cf-btn--success cf-accept-invite',
                                    dataset: { id: inv.inviteId.toString() }
                                }, 'Accept')
                            )
                        )
                    )
                )
            ),

            // Create button
            h('button', {
                class: 'cf-btn cf-btn--primary cf-btn--lg mb-4 cf-create-cartel-btn',
                style: { width: '100%' }
            }, 'Create a Cartel ($50,000)'),

            // Available cartels
            h('h3', { class: 'text-sm font-semibold mb-2' }, 'Open Cartels'),
            this._availableCartels.length === 0
                ? h('p', { class: 'text-muted text-center' }, 'No cartels currently recruiting')
                : this._availableCartels.map(c =>
                    h('div', { class: 'cf-card mb-2' },
                        h('div', { class: 'cf-card__body' },
                            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                                h('div', {},
                                    h('div', { class: 'font-semibold' }, `${c.name} [${c.tag}]`),
                                    h('div', { class: 'text-xs text-muted' },
                                        `Level ${c.level} | ${c.memberCount}/${c.maxMembers} members`
                                    ),
                                    c.minLevelRequirement > 1 && h('div', { class: 'text-xs', style: { color: 'var(--color-warning)' } },
                                        `Requires level ${c.minLevelRequirement}`
                                    )
                                ),
                                h('button', {
                                    class: 'cf-btn cf-btn--sm cf-btn--primary cf-join-cartel',
                                    dataset: { id: c.id.toString() }
                                }, 'Join')
                            )
                        )
                    )
                )
        );
    }

    _renderCreateModal() {
        return h('div', {
            class: 'cf-modal-backdrop',
            style: {
                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,0.7)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', zIndex: 1000
            }
        },
            h('div', {
                style: {
                    background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)',
                    maxWidth: '400px', width: '90%', padding: 'var(--space-4)'
                }
            },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-3)' } },
                    h('h3', { class: 'font-semibold' }, 'Create Cartel'),
                    h('button', { class: 'cf-modal-close cf-btn cf-btn--ghost' }, '×')
                ),

                h('p', { class: 'text-sm text-muted mb-3' }, 'Cost: $50,000'),

                h('div', { class: 'mb-3' },
                    h('label', { class: 'text-xs text-muted' }, 'Name (3-50 characters)'),
                    h('input', {
                        type: 'text',
                        class: 'cf-input cf-cartel-name',
                        placeholder: 'Cartel name',
                        maxlength: 50
                    })
                ),

                h('div', { class: 'mb-3' },
                    h('label', { class: 'text-xs text-muted' }, 'Tag (2-5 characters)'),
                    h('input', {
                        type: 'text',
                        class: 'cf-input cf-cartel-tag',
                        placeholder: 'TAG',
                        maxlength: 5,
                        style: { textTransform: 'uppercase' }
                    })
                ),

                h('div', { class: 'mb-3' },
                    h('label', { class: 'text-xs text-muted' }, 'Description (optional)'),
                    h('textarea', {
                        class: 'cf-input cf-cartel-desc',
                        placeholder: 'About your cartel...',
                        rows: 3
                    })
                ),

                h('button', {
                    class: 'cf-btn cf-btn--primary cf-create-submit',
                    style: { width: '100%' }
                }, 'Create Cartel')
            )
        );
    }

    _renderContributeModal() {
        return h('div', {
            class: 'cf-modal-backdrop',
            style: {
                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,0.7)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', zIndex: 1000
            }
        },
            h('div', {
                style: {
                    background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)',
                    maxWidth: '350px', width: '90%', padding: 'var(--space-4)'
                }
            },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-3)' } },
                    h('h3', { class: 'font-semibold' }, 'Contribute Cash'),
                    h('button', { class: 'cf-modal-close cf-btn cf-btn--ghost' }, '×')
                ),

                h('div', { class: 'mb-3' },
                    h('label', { class: 'text-xs text-muted' }, 'Amount'),
                    h('input', {
                        type: 'number',
                        class: 'cf-input cf-contribute-input',
                        placeholder: '10000',
                        min: 1
                    })
                ),

                h('button', {
                    class: 'cf-btn cf-btn--primary cf-contribute-submit',
                    style: { width: '100%' }
                }, 'Contribute')
            )
        );
    }
}

registerComponent('cf-cartel', CFCartel);
export default CFCartel;
