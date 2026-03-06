/**
 * CertiFried Extension - Market Component
 * View prices and buy/sell on player market
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatPercent } from '../utils/format.js';
import { api } from '../api/client.js';

class CFMarket extends CFBaseComponent {
    constructor() {
        super();
        this._activeView = 'prices'; // 'prices' | 'listings' | 'my-listings'
    }

    _setupSubscriptions() {
        this.subscribe('market');
    }

    onMount() {
        // Load market prices on mount
        this._loadPrices();

        // Tab switching
        this.on('click', '.cf-market__tab', (e) => {
            const tab = e.target.closest('.cf-market__tab');
            if (!tab) return;
            this._activeView = tab.dataset.view;
            this.render();

            if (this._activeView === 'listings') {
                this._loadListings();
            } else if (this._activeView === 'my-listings') {
                this._loadMyListings();
            }
        });

        // Buy listing
        this.on('click', '.cf-listing__buy', async (e) => {
            const buyBtn = e.target.closest('.cf-listing__buy');
            if (!buyBtn) return;
            const listingId = buyBtn.dataset.listingId;
            const qty = parseInt(buyBtn.dataset.qty) || 1;
            await this._buyListing(listingId, qty);
        });

        // Cancel listing
        this.on('click', '.cf-listing__cancel', async (e) => {
            const cancelBtn = e.target.closest('.cf-listing__cancel');
            if (!cancelBtn) return;
            const listingId = cancelBtn.dataset.listingId;
            await this._cancelListing(listingId);
        });
    }

    async _loadPrices() {
        // Only show spinner on first load when we have no data
        const prices = this.getState('market.prices') || [];
        const isFirstLoad = prices.length === 0;

        if (isFirstLoad) {
            this.setState('market.isLoading', true);
        }

        try {
            const result = await api.getMarketPrices();
            // API returns { success, prices: [...] }
            this.setState('market.prices', result.prices || result || []);
        } catch (error) {
            console.error('Failed to load prices:', error);
        } finally {
            this.setState('market.isLoading', false);
        }
    }

    async _loadListings(strainId = null) {
        // Only show spinner on first load when we have no data
        const listings = this.getState('market.listings') || [];
        const isFirstLoad = listings.length === 0;

        if (isFirstLoad) {
            this.setState('market.isLoading', true);
        }

        try {
            const result = await api.getListings(strainId);
            // API returns { success, listings: [...] }
            this.setState('market.listings', result.listings || result || []);
        } catch (error) {
            console.error('Failed to load listings:', error);
        } finally {
            this.setState('market.isLoading', false);
        }
    }

    async _loadMyListings() {
        // Only show spinner on first load when we have no data
        const myListings = this.getState('market.myListings') || [];
        const isFirstLoad = myListings.length === 0;

        if (isFirstLoad) {
            this.setState('market.isLoading', true);
        }

        try {
            // Use dedicated my-listings endpoint
            const result = await api.getMyListings();
            this.setState('market.myListings', result.listings || []);
        } catch (error) {
            console.error('Failed to load my listings:', error);
            this.setState('market.myListings', []);
        } finally {
            this.setState('market.isLoading', false);
        }
    }

    async _cancelListing(listingId) {
        // Get listing info before canceling for inventory update
        const myListings = this.getState('market.myListings') || [];
        const listing = myListings.find(l => l.id?.toString() === listingId);
        if (!listing) return;

        // Save state for rollback
        const oldMyListings = myListings;
        const oldItems = this.getState('inventory.items') || [];

        // Optimistic update: remove listing immediately
        const updatedMyListings = myListings.filter(l => l.id?.toString() !== listingId);
        this.setState('market.myListings', updatedMyListings);

        // Optimistic update: add items back to inventory
        const existingIndex = oldItems.findIndex(i =>
            i.strainId === listing.strainId && i.quality === listing.quality
        );
        let optimisticItems;
        if (existingIndex >= 0) {
            optimisticItems = [...oldItems];
            optimisticItems[existingIndex] = {
                ...optimisticItems[existingIndex],
                quantity: optimisticItems[existingIndex].quantity + listing.quantity
            };
        } else {
            optimisticItems = [...oldItems, {
                id: Date.now(),
                strainId: listing.strainId,
                strainName: listing.strainName,
                quality: listing.quality,
                quantity: listing.quantity,
                source: 'listing_cancel'
            }];
        }
        this.setState('inventory.items', optimisticItems);

        try {
            await api.cancelListing(listingId);

            this.emit('notification', {
                type: 'success',
                message: 'Listing cancelled'
            });

            // Background refresh for accurate state
            this._loadMyListings();

        } catch (error) {
            // Rollback on error
            this.setState('market.myListings', oldMyListings);
            this.setState('inventory.items', oldItems);

            this.emit('notification', {
                type: 'error',
                message: error.message || 'Cancel failed'
            });
        }
    }

    render() {
        const prices = this.getState('market.prices') || [];
        const listings = this.getState('market.listings') || [];
        const isLoading = this.getState('market.isLoading');

        this.className = 'cf-section cf-section--market';
        this.setContent(
            // Section header
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Market')
            ),

            // Tabs
            h('div', { class: 'cf-tabs' },
                h('button', {
                    class: `cf-tab cf-market__tab ${this._activeView === 'prices' ? 'cf-tab--active' : ''}`,
                    dataset: { view: 'prices' }
                }, 'Prices'),
                h('button', {
                    class: `cf-tab cf-market__tab ${this._activeView === 'listings' ? 'cf-tab--active' : ''}`,
                    dataset: { view: 'listings' }
                }, 'Buy'),
                h('button', {
                    class: `cf-tab cf-market__tab ${this._activeView === 'my-listings' ? 'cf-tab--active' : ''}`,
                    dataset: { view: 'my-listings' }
                }, 'My Listings')
            ),

            // Loading
            isLoading && h('div', { class: 'cf-loading mt-4' },
                h('div', { class: 'cf-spinner' })
            ),

            // Content based on active view
            !isLoading && this._activeView === 'prices' && this._renderPrices(prices),
            !isLoading && this._activeView === 'listings' && this._renderListings(listings),
            !isLoading && this._activeView === 'my-listings' && this._renderMyListings(this.getState('market.myListings') || [])
        );
    }

    _renderPrices(prices) {
        if (prices.length === 0) {
            return h('div', { class: 'cf-empty mt-4' },
                h('p', { class: 'cf-empty__description' }, 'No price data available')
            );
        }

        return h('div', { class: 'cf-market-prices mt-3' },
            ...prices.map(price => this._renderPriceRow(price))
        );
    }

    _renderPriceRow(price) {
        // Support both camelCase (from API) and snake_case (fallback)
        const change = price.changePercent || price.change_24h || 0;
        const strainName = price.strainName || price.strain_name || 'Unknown';
        const supplyVolume = price.supplyVolume || price.supply_volume || 0;
        const currentPrice = price.currentPrice || price.current_price || 0;
        const changeClass = change > 0 ? 'cf-price__change--up' : change < 0 ? 'cf-price__change--down' : '';

        return h('div', {
            class: 'cf-market-price-row',
            style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 'var(--space-2) var(--space-3)',
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--space-2)'
            }
        },
            h('div', {},
                h('div', { class: 'font-semibold' }, strainName),
                h('div', { class: 'text-xs text-muted' },
                    `Supply: ${supplyVolume}`
                )
            ),
            h('div', { class: 'text-right' },
                h('div', { class: 'cf-price' },
                    h('span', { class: 'cf-price__value' }, formatCurrency(currentPrice))
                ),
                change !== 0 && h('div', { class: `cf-price__change ${changeClass}` },
                    formatPercent(Math.abs(change) / 100, 1)
                )
            )
        );
    }

    _renderListings(listings) {
        // Filter out player's own listings by sellerId
        const playerId = this.getState('player.id');
        const playerListings = listings.filter(l => !playerId || l.sellerId !== playerId);

        if (playerListings.length === 0) {
            return h('div', { class: 'cf-empty mt-4' },
                h('p', { class: 'cf-empty__title' }, 'No listings'),
                h('p', { class: 'cf-empty__description' }, 'Be the first to list something!')
            );
        }

        return h('div', { class: 'cf-market-listings mt-3' },
            ...playerListings.map(listing => this._renderListing(listing))
        );
    }

    _renderListing(listing) {
        // Support both camelCase (from API) and snake_case (fallback)
        const strainName = listing.strainName || listing.strain_name || 'Unknown';
        const sellerName = listing.sellerName || listing.seller_name || 'Unknown';
        const pricePerUnit = listing.pricePerUnit || listing.price_per_unit || 0;

        return h('div', {
            class: 'cf-listing cf-strain-card',
            dataset: { listingId: listing.id?.toString() }
        },
            h('div', { class: 'cf-strain-card__info' },
                h('div', { class: 'cf-strain-card__name' }, strainName),
                h('div', { class: 'cf-strain-card__stats' },
                    h('span', {}, `${listing.quality}% quality`),
                    h('span', {}, `x${listing.quantity}`),
                    h('span', { class: 'text-muted' }, `by ${sellerName}`)
                )
            ),
            h('div', { class: 'cf-strain-card__actions' },
                h('div', { class: 'cf-price mb-1' },
                    h('span', { class: 'cf-price__value font-bold' },
                        formatCurrency(pricePerUnit)
                    ),
                    h('span', { class: 'text-xs text-muted' }, '/ea'),
                    listing.quantity > 1 && h('div', { class: 'text-xs text-muted' },
                        `Total: ${formatCurrency(pricePerUnit * listing.quantity)}`
                    )
                ),
                h('button', {
                    class: 'cf-listing__buy cf-btn cf-btn--primary cf-btn--sm',
                    dataset: { listingId: listing.id?.toString(), qty: listing.quantity?.toString() }
                }, listing.quantity > 1 ? `Buy All x${listing.quantity}` : 'Buy')
            )
        );
    }

    _renderMyListings(listings) {
        // /market/my-listings endpoint already returns only current player's listings
        if (listings.length === 0) {
            return h('div', { class: 'cf-empty mt-4' },
                h('p', { class: 'cf-empty__title' }, 'No active listings'),
                h('p', { class: 'cf-empty__description' }, 'List items from your inventory to sell')
            );
        }

        return h('div', { class: 'cf-market-listings mt-3' },
            ...listings.map(listing => this._renderMyListing(listing))
        );
    }

    _renderMyListing(listing) {
        // Support both camelCase (from API) and snake_case (fallback)
        const strainName = listing.strainName || listing.strain_name || 'Unknown';
        const pricePerUnit = listing.pricePerUnit || listing.price_per_unit || 0;

        return h('div', {
            class: 'cf-listing cf-strain-card',
            dataset: { listingId: listing.id?.toString() }
        },
            h('div', { class: 'cf-strain-card__info' },
                h('div', { class: 'cf-strain-card__name' }, strainName),
                h('div', { class: 'cf-strain-card__stats' },
                    h('span', {}, `${listing.quality}% quality`),
                    h('span', {}, `x${listing.quantity}`)
                )
            ),
            h('div', { class: 'cf-strain-card__actions' },
                h('div', { class: 'cf-price' },
                    h('span', { class: 'cf-price__value' }, formatCurrency(pricePerUnit))
                ),
                h('button', {
                    class: 'cf-listing__cancel cf-btn cf-btn--danger cf-btn--sm',
                    dataset: { listingId: listing.id?.toString() }
                }, 'Cancel')
            )
        );
    }

    async _buyListing(listingId, quantity = 1) {
        // Get listing info for optimistic update
        const listings = this.getState('market.listings') || [];
        const listing = listings.find(l => l.id?.toString() === listingId);
        if (!listing) return;

        const strainName = listing.strainName || listing.strain_name || 'item';
        const pricePerUnit = listing.pricePerUnit || listing.price_per_unit || 0;
        const buyQty = Math.min(quantity, listing.quantity || 1);
        const totalCost = pricePerUnit * buyQty;

        // Save state for rollback
        const oldListings = listings;
        const oldItems = this.getState('inventory.items') || [];
        const oldCash = this.getState('player.cash') || this.getState('player.currency') || 0;

        if (oldCash < totalCost) {
            this.emit('notification', { type: 'error', message: `Need ${formatCurrency(totalCost)}` });
            return;
        }

        // Optimistic update: remove listing from view
        const updatedListings = listings.filter(l => l.id?.toString() !== listingId);
        this.setState('market.listings', updatedListings);

        // Optimistic update: deduct cash
        const optimisticCash = oldCash - totalCost;
        this.setState('player.currency', optimisticCash);
        this.setState('player.cash', optimisticCash);

        // Optimistic update: add to inventory
        const existingIndex = oldItems.findIndex(i =>
            i.strainId === listing.strainId && i.quality === listing.quality
        );
        let optimisticItems;
        if (existingIndex >= 0) {
            optimisticItems = [...oldItems];
            optimisticItems[existingIndex] = {
                ...optimisticItems[existingIndex],
                quantity: optimisticItems[existingIndex].quantity + buyQty
            };
        } else {
            optimisticItems = [...oldItems, {
                id: Date.now(),
                strainId: listing.strainId,
                strainName: listing.strainName,
                quality: listing.quality,
                quantity: buyQty,
                source: 'market_buy'
            }];
        }
        this.setState('inventory.items', optimisticItems);

        try {
            const result = await api.buyListing(listingId, buyQty);

            this.emit('notification', {
                type: 'success',
                message: `Purchased ${buyQty}x ${strainName}!`
            });

            // Update with accurate server values
            const newBalance = result.newCash || result.new_balance;
            if (newBalance !== undefined) {
                this.setState('player.currency', newBalance);
                this.setState('player.cash', newBalance);
            }

            // Background refresh for accurate listings
            this._loadListings();

        } catch (error) {
            // Rollback on error
            this.setState('market.listings', oldListings);
            this.setState('inventory.items', oldItems);
            this.setState('player.currency', oldCash);
            this.setState('player.cash', oldCash);

            this.emit('notification', {
                type: 'error',
                message: error.message || 'Purchase failed'
            });
        }
    }
}

registerComponent('cf-market', CFMarket);
export default CFMarket;
