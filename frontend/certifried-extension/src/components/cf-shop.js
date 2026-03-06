/**
 * CertiFried Extension - Shop Component
 * NPC Shop for buying seeds, boosters, upgrades, and workers
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { api } from '../api/client.js';

class CFShop extends CFBaseComponent {
    constructor() {
        super();
        this._activeCategory = 'deals';
        this._items = [];
        this._deals = [];
        this._isLoading = true;
        this._categories = ['deals', 'seeds', 'boosters', 'upgrades', 'workers'];
        this._quantities = {}; // Track selected quantity per item
    }

    _setupSubscriptions() {
        // Subscribe to player currency for live updates when spending elsewhere
        this.subscribe('player.currency');
    }

    onMount() {
        this._loadShopItems();

        // Tab switching
        this.on('click', '.cf-shop__tab', (e) => {
            const tab = e.target.closest('.cf-shop__tab');
            if (!tab) return;
            this._activeCategory = tab.dataset.category;
            this.render();
        });

        // Buy item
        this.on('click', '.cf-shop__buy-btn', async (e) => {
            const btn = e.target.closest('.cf-shop__buy-btn');
            if (!btn || btn.disabled) return;
            const itemId = btn.dataset.itemId;
            const quantity = this._quantities[itemId] || 1;
            await this._buyItem(itemId, quantity);
        });

        // Quantity controls
        this.on('click', '.cf-shop__qty-minus', (e) => {
            const btn = e.target.closest('.cf-shop__qty-minus');
            if (!btn) return;
            const itemId = btn.dataset.itemId;
            const current = this._quantities[itemId] || 1;
            if (current > 1) {
                this._quantities[itemId] = current - 1;
                this.render();
            }
        });

        this.on('click', '.cf-shop__qty-plus', (e) => {
            const btn = e.target.closest('.cf-shop__qty-plus');
            if (!btn) return;
            const itemId = btn.dataset.itemId;
            const item = this._items.find(i => i.id === itemId);
            const current = this._quantities[itemId] || 1;
            const maxQty = item?.maxOwned ? (item.maxOwned - (item.owned || 0)) : 99;
            if (current < Math.min(maxQty, 99)) {
                this._quantities[itemId] = current + 1;
                this.render();
            }
        });

        // Quick quantity buttons (x5, x10)
        this.on('click', '.cf-shop__qty-quick', (e) => {
            const btn = e.target.closest('.cf-shop__qty-quick');
            if (!btn) return;
            const itemId = btn.dataset.itemId;
            const qty = parseInt(btn.dataset.qty, 10);
            const item = this._items.find(i => i.id === itemId);
            const maxQty = item?.maxOwned ? (item.maxOwned - (item.owned || 0)) : 99;
            this._quantities[itemId] = Math.min(qty, maxQty);
            this.render();
        });

        // Buy deal
        this.on('click', '.cf-shop__buy-deal-btn', async (e) => {
            const btn = e.target.closest('.cf-shop__buy-deal-btn');
            if (!btn || btn.disabled) return;
            const dealId = parseInt(btn.dataset.dealId, 10);
            await this._buyDeal(dealId);
        });
    }

    async _loadShopItems() {
        // Only show loading spinner on first load if we have no data yet
        const isFirstLoad = this._items.length === 0 && this._deals.length === 0;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            // Load shop items and deals in parallel
            const [data, dealsData] = await Promise.all([
                api.getShopItems(),
                api.getShopDeals().catch(() => ({ deals: [] }))
            ]);

            // New API returns seeds, boosters, upgrades, workers separately
            this._items = [
                ...(data.seeds || []),
                ...(data.boosters || []),
                ...(data.upgrades || []),
                ...(data.workers || [])
            ];
            this._deals = dealsData.deals || [];
            this._playerCurrency = data.playerCash || 0;
            this._seedInventory = data.seedInventory || [];

        } catch (error) {
            console.error('Failed to load shop:', error);
            // Only clear items on first load failure
            if (isFirstLoad) {
                this._items = [];
                this._deals = [];
            }
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    async _buyItem(itemId, quantity = 1) {
        const item = this._items.find(i => i.id === itemId);
        if (!item) return;

        const totalPrice = item.price * quantity;
        const isSeed = item.category === 'seeds';
        const packSize = item.pack || 1;

        // Save state for rollback
        const oldCurrency = this._playerCurrency;
        const oldItems = JSON.parse(JSON.stringify(this._items));
        const oldStrains = this.getState('player.unlockedStrains') || [];

        // Optimistic update immediately
        this._playerCurrency -= totalPrice;
        this.setState('player.currency', this._playerCurrency);

        const itemIndex = this._items.findIndex(i => i.id === itemId);
        if (itemIndex !== -1) {
            if (isSeed) {
                this._items[itemIndex].owned = (this._items[itemIndex].owned || 0) + (packSize * quantity);
            } else {
                this._items[itemIndex].owned = (this._items[itemIndex].owned || 0) + quantity;
                if (this._items[itemIndex].maxOwned) {
                    this._items[itemIndex].canBuy = this._items[itemIndex].owned < this._items[itemIndex].maxOwned;
                }
            }
        }
        this._quantities[itemId] = 1;
        this.scheduleRender();

        const qtyText = quantity > 1 ? ` (x${quantity})` : '';
        this.emit('notification', {
            type: 'success',
            message: `Purchased ${item.name}${qtyText}!`
        });

        try {
            const result = await api.buyShopItem(itemId, quantity);

            // Update with actual server values
            if (result.currency !== undefined) {
                this._playerCurrency = result.currency;
                this.setState('player.currency', result.currency);
            }

            // For seeds, refresh available strains (background, non-blocking)
            if (isSeed) {
                api.getAvailableStrains().then(strainsData => {
                    this.setState('player.unlockedStrains', strainsData.strains || []);
                }).catch(() => {});
            }

        } catch (error) {
            // Rollback on failure
            this._playerCurrency = oldCurrency;
            this._items = oldItems;
            this.setState('player.currency', oldCurrency);
            this.setState('player.unlockedStrains', oldStrains);
            this.scheduleRender();

            this.emit('notification', {
                type: 'error',
                message: error.message || 'Purchase failed'
            });
        }
    }

    async _buyDeal(dealId) {
        const deal = this._deals.find(d => d.id === dealId);
        if (!deal) return;

        // Save state for rollback
        const oldCurrency = this._playerCurrency;
        const oldDeals = JSON.parse(JSON.stringify(this._deals));

        // Optimistic update immediately
        this._playerCurrency -= deal.discountedPrice;
        this.setState('player.currency', this._playerCurrency);

        // Update deal stock optimistically
        const dealIndex = this._deals.findIndex(d => d.id === dealId);
        if (dealIndex !== -1 && this._deals[dealIndex].maxPurchases) {
            this._deals[dealIndex].currentPurchases = (this._deals[dealIndex].currentPurchases || 0) + 1;
        }
        this.scheduleRender();

        this.emit('notification', {
            type: 'success',
            message: `Purchased ${deal.strainName} deal!`
        });

        try {
            const result = await api.buyShopDeal(dealId, 1);

            if (result.currency !== undefined) {
                this._playerCurrency = result.currency;
                this.setState('player.currency', result.currency);
            }

            // Refresh deals in background (non-blocking)
            api.getShopDeals().then(dealsData => {
                this._deals = dealsData.deals || [];
                this.scheduleRender();
            }).catch(() => {});

            // Refresh strains (background, non-blocking)
            api.getAvailableStrains().then(strainsData => {
                this.setState('player.unlockedStrains', strainsData.strains || []);
            }).catch(() => {});

        } catch (error) {
            // Rollback on failure
            this._playerCurrency = oldCurrency;
            this._deals = oldDeals;
            this.setState('player.currency', oldCurrency);
            this.scheduleRender();

            this.emit('notification', {
                type: 'error',
                message: error.message || 'Purchase failed'
            });
        }
    }

    render() {
        const player = this.getState('player') || {};
        const currency = this._playerCurrency || player.cash || 0;

        this.className = 'cf-section cf-section--shop';

        if (this._isLoading) {
            this.setContent(
                h('div', { class: 'cf-section__header' },
                    h('h2', { class: 'cf-section__title' }, 'Shop')
                ),
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' })
                )
            );
            return;
        }

        const categoryItems = this._items.filter(i => i.category === this._activeCategory);
        const isDealsTab = this._activeCategory === 'deals';

        this.setContent(
            // Header with currency
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Shop'),
                h('div', { class: 'cf-shop__currency' },
                    this._renderCurrencyIcon(),
                    h('span', { class: 'cf-shop__currency-value' }, formatCurrency(currency))
                )
            ),

            // Category tabs
            h('div', { class: 'cf-tabs cf-shop__tabs' },
                ...this._categories.map(cat => this._renderTab(cat))
            ),

            // Category description
            h('div', { class: 'cf-shop__description text-xs text-muted mb-3' },
                this._getCategoryDescription()
            ),

            // Items/Deals grid
            isDealsTab
                ? this._renderDealsSection(currency)
                : (categoryItems.length === 0
                    ? h('div', { class: 'cf-empty' },
                        h('p', { class: 'cf-empty__title' }, 'No items available'),
                        h('p', { class: 'cf-empty__description' }, 'Check back later!')
                      )
                    : h('div', { class: 'cf-shop__items' },
                        ...categoryItems.map(item => this._renderItem(item, currency))
                      ))
        );
    }

    _renderDealsSection(playerCurrency) {
        if (this._deals.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No active deals'),
                h('p', { class: 'cf-empty__description' }, 'Check back later for special offers!')
            );
        }

        return h('div', { class: 'cf-shop__deals' },
            ...this._deals.map(deal => this._renderDeal(deal, playerCurrency))
        );
    }

    _renderDeal(deal, playerCurrency) {
        const canAfford = playerCurrency >= deal.discountedPrice;
        const isSoldOut = deal.maxPurchases && deal.currentPurchases >= deal.maxPurchases;
        const canBuy = canAfford && !isSoldOut;

        const typeLabels = {
            daily_deal: 'Daily Deal',
            weekly_special: 'Weekly Special',
            flash_sale: 'Flash Sale'
        };

        const typeColors = {
            daily_deal: 'var(--color-success)',
            weekly_special: 'var(--color-info)',
            flash_sale: 'var(--color-warning)'
        };

        const rarityColors = {
            common: 'var(--color-gray-400)',
            uncommon: 'var(--color-success)',
            rare: 'var(--color-info)',
            epic: 'var(--color-warning)',
            legendary: 'var(--color-accent-500)'
        };

        // Calculate time remaining
        const endsAt = new Date(deal.endsAt);
        const now = new Date();
        const hoursLeft = Math.max(0, Math.floor((endsAt - now) / (1000 * 60 * 60)));
        const minsLeft = Math.max(0, Math.floor((endsAt - now) / (1000 * 60)) % 60);

        return h('div', {
            class: `cf-shop__deal ${!canBuy ? 'cf-shop__deal--disabled' : ''} ${isSoldOut ? 'cf-shop__deal--soldout' : ''}`,
            style: { borderLeftColor: typeColors[deal.rotationType] || 'var(--border-primary)' }
        },
            // Deal type badge
            h('div', { class: 'cf-shop__deal-badge', style: { background: typeColors[deal.rotationType] } },
                typeLabels[deal.rotationType] || 'Deal'
            ),

            // Strain info
            h('div', { class: 'cf-shop__deal-info' },
                h('div', { class: 'cf-shop__deal-header' },
                    h('span', { class: 'cf-shop__deal-name' }, deal.strainName),
                    h('span', {
                        class: 'cf-shop__deal-rarity',
                        style: { color: rarityColors[deal.rarity] }
                    }, deal.rarity)
                ),

                // Discount display
                h('div', { class: 'cf-shop__deal-discount' },
                    h('span', { class: 'cf-shop__deal-original', style: { textDecoration: 'line-through', color: 'var(--text-muted)' } },
                        formatCurrency(deal.originalPrice)
                    ),
                    h('span', { class: 'cf-shop__deal-price', style: { color: 'var(--color-success)', fontWeight: 'bold', marginLeft: '8px' } },
                        formatCurrency(deal.discountedPrice)
                    ),
                    h('span', { class: 'cf-badge', style: { background: 'var(--color-success-500)', marginLeft: '8px' } },
                        `-${deal.discountPercent}%`
                    )
                ),

                // Bonus seeds
                deal.bonusSeeds > 0 && h('div', { class: 'cf-shop__deal-bonus', style: { color: 'var(--color-accent-400)', fontSize: '12px' } },
                    `+${deal.bonusSeeds} bonus seed${deal.bonusSeeds > 1 ? 's' : ''}!`
                ),

                // Time remaining
                h('div', { class: 'cf-shop__deal-timer text-xs', style: { color: 'var(--text-muted)', marginTop: '4px' } },
                    `Ends in: ${hoursLeft}h ${minsLeft}m`
                ),

                // Stock for flash sales
                deal.maxPurchases && h('div', { class: 'cf-shop__deal-stock text-xs' },
                    `Stock: ${deal.maxPurchases - deal.currentPurchases}/${deal.maxPurchases}`
                )
            ),

            // Buy button
            h('button', {
                class: `cf-btn cf-btn--primary cf-shop__buy-deal-btn ${!canBuy ? 'cf-btn--disabled' : ''}`,
                disabled: !canBuy,
                dataset: { dealId: deal.id }
            },
                isSoldOut ? 'Sold Out' : (canAfford ? 'Buy Deal' : 'Not Enough Cash')
            )
        );
    }

    _renderTab(category) {
        const labels = {
            deals: 'Hot Deals',
            seeds: 'Seeds',
            boosters: 'Boosters',
            upgrades: 'Upgrades',
            workers: 'Workers'
        };

        const icons = {
            deals: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
            seeds: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z',
            boosters: 'M13 2.05v2.02c3.95.49 7 3.85 7 7.93 0 3.21-1.92 6-4.72 7.28L13 17v5h-2v-5l-2.28 2.28C5.92 18 4 15.21 4 12c0-4.08 3.05-7.44 7-7.93V2.05h2z',
            upgrades: 'M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6h-6z',
            workers: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'
        };

        // Add deal count badge
        const dealCount = category === 'deals' ? this._deals.length : 0;

        return h('button', {
            class: `cf-tab cf-shop__tab ${this._activeCategory === category ? 'cf-tab--active' : ''}`,
            dataset: { category }
        },
            this._renderSvgIcon(icons[category], 14),
            h('span', {}, labels[category]),
            dealCount > 0 && h('span', { class: 'cf-badge cf-badge--accent', style: { marginLeft: '4px', fontSize: '10px' } }, String(dealCount))
        );
    }

    _getCategoryDescription() {
        const descriptions = {
            deals: 'Limited time offers with discounts and bonus seeds!',
            seeds: 'Seeds are consumable - buy a pack, plant them one at a time!',
            boosters: 'Temporary boosts to speed up growth, increase yield, or gain more XP',
            upgrades: 'Permanent improvements to your grow operation',
            workers: 'Hire workers to automate harvesting, planting, and selling'
        };
        return descriptions[this._activeCategory] || '';
    }

    _renderItem(item, playerCurrency) {
        const quantity = this._quantities[item.id] || 1;
        const totalPrice = item.price * quantity;
        const canAfford = playerCurrency >= totalPrice;
        const isMaxed = item.maxOwned && item.owned >= item.maxOwned;
        const remainingSlots = item.maxOwned ? (item.maxOwned - (item.owned || 0)) : 99;
        const canBuy = item.canBuy !== false && canAfford && !isMaxed && quantity <= remainingSlots;
        const isSeed = item.category === 'seeds';
        const isBooster = item.category === 'boosters';
        const showQtySelector = (isSeed || isBooster) && !isMaxed;

        const rarityColors = {
            common: 'var(--color-gray-400)',
            uncommon: 'var(--color-success)',
            rare: 'var(--color-info)',
            epic: 'var(--color-warning)',
            legendary: 'var(--color-accent-500)'
        };

        return h('div', {
            class: `cf-shop__item ${!canBuy ? 'cf-shop__item--disabled' : ''} ${isMaxed ? 'cf-shop__item--maxed' : ''}`,
            style: item.rarity ? { borderLeftColor: rarityColors[item.rarity] || 'var(--border-primary)' } : {}
        },
            // Item info
            h('div', { class: 'cf-shop__item-info' },
                h('div', { class: 'cf-shop__item-header' },
                    h('span', { class: 'cf-shop__item-name' }, item.name),
                    item.rarity && h('span', {
                        class: 'cf-shop__item-rarity',
                        style: { color: rarityColors[item.rarity] }
                    }, item.rarity),
                    // Show pack size for seeds
                    isSeed && item.pack && h('span', {
                        class: 'cf-badge',
                        style: { background: 'var(--color-success-500)', marginLeft: '4px', fontSize: '10px' }
                    }, `${item.pack} pack`)
                ),
                h('p', { class: 'cf-shop__item-desc' }, item.description),
                // Show owned count (seeds show inventory count)
                item.owned > 0 && h('span', { class: 'cf-shop__item-owned text-xs' },
                    isSeed
                        ? `In inventory: ${item.owned} seeds`
                        : `Owned: ${item.owned}${item.maxOwned ? `/${item.maxOwned}` : ''}`
                )
            ),

            // Quantity selector (for seeds and boosters)
            showQtySelector && h('div', { class: 'cf-shop__qty-selector' },
                h('div', { class: 'cf-shop__qty-controls' },
                    h('button', {
                        class: 'cf-shop__qty-minus cf-btn cf-btn--sm',
                        dataset: { itemId: item.id },
                        disabled: quantity <= 1
                    }, '-'),
                    h('span', { class: 'cf-shop__qty-value' }, quantity.toString()),
                    h('button', {
                        class: 'cf-shop__qty-plus cf-btn cf-btn--sm',
                        dataset: { itemId: item.id },
                        disabled: quantity >= Math.min(remainingSlots, 99)
                    }, '+')
                ),
                h('div', { class: 'cf-shop__qty-quick-btns' },
                    h('button', {
                        class: 'cf-shop__qty-quick cf-btn cf-btn--xs',
                        dataset: { itemId: item.id, qty: '5' }
                    }, 'x5'),
                    h('button', {
                        class: 'cf-shop__qty-quick cf-btn cf-btn--xs',
                        dataset: { itemId: item.id, qty: '10' }
                    }, 'x10')
                )
            ),

            // Price and buy button
            h('div', { class: 'cf-shop__item-action' },
                h('div', { class: `cf-shop__item-price ${!canAfford ? 'cf-shop__item-price--expensive' : ''}` },
                    this._renderCurrencyIcon(12),
                    h('span', {}, formatCurrency(totalPrice)),
                    quantity > 1 && h('span', { class: 'cf-shop__price-each text-xs text-muted' },
                        ` (${formatCurrency(item.price)} each)`
                    )
                ),
                h('button', {
                    class: 'cf-shop__buy-btn cf-btn cf-btn--primary cf-btn--sm',
                    dataset: { itemId: item.id },
                    disabled: !canBuy || isMaxed
                }, isMaxed ? 'Maxed' : (quantity > 1 ? `Buy x${quantity}` : 'Buy'))
            )
        );
    }

    _renderCurrencyIcon(size = 16) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', size.toString());
        svg.setAttribute('height', size.toString());
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'var(--color-accent-500)');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.31-8.86c-1.77-.45-2.34-.94-2.34-1.67 0-.84.79-1.43 2.1-1.43 1.38 0 1.9.66 1.94 1.64h1.71c-.05-1.34-.87-2.57-2.49-2.97V5H10.9v1.69c-1.51.32-2.72 1.3-2.72 2.81 0 1.79 1.49 2.69 3.66 3.21 1.95.46 2.34 1.15 2.34 1.87 0 .53-.39 1.39-2.1 1.39-1.6 0-2.23-.72-2.32-1.64H8.04c.1 1.7 1.36 2.66 2.86 2.97V19h2.34v-1.67c1.52-.29 2.72-1.16 2.73-2.77-.01-2.2-1.9-2.96-3.66-3.42z');
        svg.appendChild(path);

        return svg;
    }

    _renderSvgIcon(pathD, size = 16) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', size.toString());
        svg.setAttribute('height', size.toString());
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'currentColor');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathD);
        svg.appendChild(path);

        return svg;
    }
}

registerComponent('cf-shop', CFShop);
export default CFShop;
