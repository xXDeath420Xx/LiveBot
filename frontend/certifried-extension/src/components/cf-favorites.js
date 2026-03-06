/**
 * Strain Favorites Component
 * Manage player's favorite strains for quick access
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatRarity, formatTimeRemaining } from '../utils/format.js';

class CFFavorites extends CFBaseComponent {
    constructor() {
        super();
        this._favorites = [];
        this._maxFavorites = 10;
        this._loading = true;
        this._error = null;
        this._showAddModal = false;
        this._availableStrains = [];
    }

    async onMount() {
        await this._loadFavorites();

        // Handle add favorite button
        this.on('click', '.cf-add-favorite-btn', () => {
            this._openAddModal();
        });

        // Handle remove favorite
        this.on('click', '.cf-remove-favorite', async (e) => {
            const btn = e.target.closest('.cf-remove-favorite');
            if (!btn) return;
            const strainId = parseInt(btn.dataset.strainId, 10);
            await this._removeFavorite(strainId);
        });

        // Handle move up
        this.on('click', '.cf-move-up', async (e) => {
            const btn = e.target.closest('.cf-move-up');
            if (!btn) return;
            const index = parseInt(btn.dataset.index, 10);
            await this._moveUp(index);
        });

        // Handle move down
        this.on('click', '.cf-move-down', async (e) => {
            const btn = e.target.closest('.cf-move-down');
            if (!btn) return;
            const index = parseInt(btn.dataset.index, 10);
            await this._moveDown(index);
        });

        // Handle add strain from modal
        this.on('click', '.cf-strain-add-option', async (e) => {
            const option = e.target.closest('.cf-strain-add-option');
            if (!option) return;
            const strainId = parseInt(option.dataset.strainId, 10);
            await this._addFavorite(strainId);
        });

        // Handle close modal
        this.on('click', '.cf-modal-backdrop', (e) => {
            if (e.target.classList.contains('cf-modal-backdrop')) {
                this._showAddModal = false;
                this.render();
            }
        });

        this.on('click', '.cf-modal-close', () => {
            this._showAddModal = false;
            this.render();
        });
    }

    async _loadFavorites() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._favorites.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getFavorites();
            if (response.success) {
                this._favorites = response.favorites || [];
                this._maxFavorites = response.maxFavorites || 10;
            } else {
                this._error = response.error || 'Failed to load favorites';
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _loadAvailableStrains() {
        try {
            const response = await api.getStrainCollection();
            if (response.success) {
                // Filter out already favorited strains
                const favoritedIds = new Set(this._favorites.map(f => f.strainId));
                this._availableStrains = (response.strains || [])
                    .filter(s => !favoritedIds.has(s.id));
            }
        } catch (err) {
            console.error('[Favorites] Failed to load strains:', err);
        }
    }

    async _openAddModal() {
        await this._loadAvailableStrains();
        this._showAddModal = true;
        this.render();
    }

    async _addFavorite(strainId) {
        try {
            const response = await api.addFavorite(strainId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                this._showAddModal = false;
                await this._loadFavorites();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _removeFavorite(strainId) {
        try {
            const response = await api.removeFavorite(strainId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: 'Removed from favorites' });
                await this._loadFavorites();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _moveUp(index) {
        if (index <= 0) return;
        const order = this._favorites.map(f => f.strainId);
        [order[index - 1], order[index]] = [order[index], order[index - 1]];
        await this._reorder(order);
    }

    async _moveDown(index) {
        if (index >= this._favorites.length - 1) return;
        const order = this._favorites.map(f => f.strainId);
        [order[index], order[index + 1]] = [order[index + 1], order[index]];
        await this._reorder(order);
    }

    async _reorder(order) {
        try {
            const response = await api.reorderFavorites(order);
            if (response.success) {
                await this._loadFavorites();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-favorites';

        if (this._loading) {
            this.setContent(
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' })
                )
            );
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', {
                        class: 'cf-btn cf-btn--primary',
                        onclick: () => this._loadFavorites()
                    }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        // Header with count
        content.push(
            h('div', {
                style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 'var(--space-4)'
                }
            },
                h('h2', { class: 'cf-section__title' }, 'Favorite Strains'),
                h('span', { class: 'text-sm text-muted' },
                    `${this._favorites.length}/${this._maxFavorites}`
                )
            )
        );

        // Favorites list
        if (this._favorites.length === 0) {
            content.push(
                h('div', { class: 'cf-empty' },
                    h('p', { class: 'cf-empty__title' }, 'No favorites yet'),
                    h('p', { class: 'cf-empty__description' },
                        'Add your favorite strains for quick access when planting!'
                    )
                )
            );
        } else {
            content.push(
                h('div', { class: 'cf-favorites-list' },
                    ...this._favorites.map((fav, index) => this._renderFavorite(fav, index))
                )
            );
        }

        // Add button
        if (this._favorites.length < this._maxFavorites) {
            content.push(
                h('button', {
                    class: 'cf-btn cf-btn--primary cf-add-favorite-btn',
                    style: { width: '100%', marginTop: 'var(--space-3)' }
                }, '+ Add Favorite')
            );
        }

        // Add modal
        if (this._showAddModal) {
            content.push(this._renderAddModal());
        }

        this.setContent(...content);
    }

    _renderFavorite(fav, index) {
        const strain = fav.strain;
        const rarityInfo = formatRarity(strain.rarity || 'common');

        return h('div', {
            class: 'cf-card cf-favorite-item',
            style: { marginBottom: 'var(--space-2)' }
        },
            h('div', {
                class: 'cf-card__body',
                style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)'
                }
            },
                // Reorder controls
                h('div', {
                    style: {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px'
                    }
                },
                    h('button', {
                        class: 'cf-btn cf-btn--ghost cf-btn--xs cf-move-up',
                        dataset: { index: index.toString() },
                        disabled: index === 0,
                        style: { padding: '2px 6px', fontSize: '10px' }
                    }, '▲'),
                    h('button', {
                        class: 'cf-btn cf-btn--ghost cf-btn--xs cf-move-down',
                        dataset: { index: index.toString() },
                        disabled: index === this._favorites.length - 1,
                        style: { padding: '2px 6px', fontSize: '10px' }
                    }, '▼')
                ),

                // Strain icon
                h('div', {
                    style: {
                        width: '40px',
                        height: '40px',
                        background: 'var(--bg-tertiary)',
                        borderRadius: 'var(--radius-md)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }
                }, this._renderPlantIcon()),

                // Strain info
                h('div', { style: { flex: 1 } },
                    h('div', { class: 'font-semibold' }, strain.name),
                    h('div', {
                        style: {
                            display: 'flex',
                            gap: 'var(--space-2)',
                            flexWrap: 'wrap',
                            marginTop: '4px'
                        }
                    },
                        h('span', {
                            class: 'cf-badge',
                            style: { background: rarityInfo.color, fontSize: '10px' }
                        }, rarityInfo.name),
                        h('span', { class: 'text-xs text-muted' },
                            `$${strain.basePrice.toLocaleString()}`
                        ),
                        h('span', { class: 'text-xs text-muted' },
                            `${strain.thc}% THC`
                        )
                    )
                ),

                // Remove button
                h('button', {
                    class: 'cf-btn cf-btn--ghost cf-btn--sm cf-remove-favorite',
                    dataset: { strainId: strain.id.toString() },
                    style: { color: 'var(--color-danger)' }
                }, '×')
            )
        );
    }

    _renderAddModal() {
        return h('div', {
            class: 'cf-modal-backdrop',
            style: {
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0,0,0,0.7)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
            }
        },
            h('div', {
                class: 'cf-modal',
                style: {
                    background: 'var(--bg-primary)',
                    borderRadius: 'var(--radius-lg)',
                    maxWidth: '400px',
                    width: '90%',
                    maxHeight: '80vh',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column'
                }
            },
                // Header
                h('div', {
                    style: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: 'var(--space-4)',
                        borderBottom: '1px solid var(--border-primary)'
                    }
                },
                    h('h3', { class: 'font-semibold' }, 'Add to Favorites'),
                    h('button', { class: 'cf-modal-close cf-btn cf-btn--ghost' }, '×')
                ),

                // Body
                h('div', {
                    style: {
                        padding: 'var(--space-4)',
                        overflowY: 'auto',
                        flex: 1
                    }
                },
                    this._availableStrains.length === 0
                        ? h('p', { class: 'text-muted text-center' }, 'No strains available to add')
                        : h('div', { class: 'cf-strain-list' },
                            ...this._availableStrains.map(strain => this._renderStrainOption(strain))
                        )
                )
            )
        );
    }

    _renderStrainOption(strain) {
        const rarityInfo = formatRarity(strain.rarity || 'common');

        return h('div', {
            class: 'cf-strain-add-option cf-card',
            dataset: { strainId: strain.id.toString() },
            style: {
                marginBottom: 'var(--space-2)',
                cursor: 'pointer',
                transition: 'transform 0.1s'
            }
        },
            h('div', {
                class: 'cf-card__body',
                style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)'
                }
            },
                h('div', {
                    style: {
                        width: '36px',
                        height: '36px',
                        background: 'var(--bg-tertiary)',
                        borderRadius: 'var(--radius-md)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }
                }, this._renderPlantIcon()),

                h('div', { style: { flex: 1 } },
                    h('div', { class: 'font-medium' }, strain.name),
                    h('div', { style: { display: 'flex', gap: 'var(--space-2)' } },
                        h('span', {
                            class: 'cf-badge',
                            style: { background: rarityInfo.color, fontSize: '9px' }
                        }, rarityInfo.name)
                    )
                ),

                h('span', { style: { color: 'var(--color-primary)' } }, '+')
            )
        );
    }

    _renderPlantIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 64 64');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M32 8 C32 8 16 24 16 40 C16 56 32 56 32 56 C32 56 48 56 48 40 C48 24 32 8 32 8Z');
        path.setAttribute('fill', 'var(--color-primary-500)');
        svg.appendChild(path);

        return svg;
    }
}

registerComponent('cf-favorites', CFFavorites);
export default CFFavorites;
