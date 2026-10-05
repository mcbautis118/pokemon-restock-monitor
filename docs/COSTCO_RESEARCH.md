# Costco in-store inventory monitor research

Status: research/design branch. Nothing here is merged into `main` yet.

## Confirmed customer-facing capability

Costco's customer inventory feature can return warehouse-specific availability, price, item number, department, and product image. Costco states that warehouse inventory/pricing may be delayed by up to 30 minutes and out-of-stock items may not be displayed.

This is sufficient to build an in-store restock signal: unavailable/not returned -> available at a selected warehouse.

## Costco web API architecture found in public implementations

A current open-source Costco adapter documents these customer-facing endpoints:

- Search: `POST https://gdx-api.costco.com/catalog/search/api/v1/search`
- Product detail: `POST https://ecom-api.costco.com/ebusiness/product/v1/products/graphql`
- Warehouse locator: `GET https://ecom-api.costco.com/core/warehouse-locator/v1/salesLocations.json`
- Delivery options: `GET https://ecom-api.costco.com/ebusiness/order/v1/delivery/options`

The product GraphQL request accepts a `warehouseNumber`. Returned catalog data includes `buyable`, `programTypes`, and `priceData`. A public implementation maps these into `available`, `inWarehouse`, `onlineOnly`, and `price`.

Important: this does **not** establish access to Costco's internal ITMW quantities.

## Sacramento-area warehouses confirmed from Costco's public warehouse pages

Initial default watch set:

- Rancho Cordova — warehouse `438` — 11260 White Rock Rd, Rancho Cordova, CA 95742
- Sacramento — warehouse `464` — 7981 E Stockton Blvd, Sacramento, CA 95823
- Folsom — warehouse `765` — 1800 Cavitt Dr, Folsom, CA 95630
- Citrus Heights — warehouse `771` — 7000 Auburn Blvd, Citrus Heights, CA 95621

These are public Costco warehouse numbers, not inferred store IDs. Additional nearby warehouses can be added later without changing scraper logic.

## On Hand / In Transit / On Order

Community Pokémon trackers sometimes publish warehouse-level quantities such as On Hand, In Transit, and On Order. I have not found evidence that Costco exposes those fields through its documented customer inventory feature. Do not represent those quantities as available from Costco unless a legitimate customer-accessible source is verified.

The monitor should therefore be designed in two layers:

1. **Costco public warehouse availability** — primary implementation. Warehouse/item availability and price, with alerts on state transitions.
2. **Shipment intelligence** — optional future source if a reliable legitimate public/community feed for On Hand/In Transit/On Order is identified.

## Proposed monitor behavior

Configuration should support:

- explicit Costco item numbers to watch;
- explicit warehouse numbers and friendly names;
- optional product discovery/search for Pokémon TCG products;
- a disabled-by-default switch until live endpoint behavior is verified from the intended runtime.

Normalized state should retain:

- retailer: Costco
- itemNumber
- product name
- warehouseNumber
- warehouseName
- stockStatus (`in_stock` / `out_of_stock` / `unknown`)
- inWarehouse
- price
- product URL when available
- checkedAt

The unique state key must include both item and warehouse, e.g. `costco:<itemNumber>:<warehouseNumber>`, so the same SKU can alert independently at Folsom, Rancho Cordova/Sacramento-area warehouses, etc.

## Alert transitions

High-value Discord events:

- first appearance at a warehouse;
- out-of-stock/unknown -> in-stock;
- optional price change;
- future: On Order -> In Transit -> On Hand, only if a legitimate quantity source is verified.

Avoid repeatedly alerting while an item remains available.

## Runtime considerations

The existing monitor has already shown that several retailers block or challenge GitHub-hosted Actions. Costco must be tested from GitHub Actions and, if challenged, from the Oracle VM/home connection before deciding the production runtime.

## Next implementation steps

- [x] Isolate work on `feature/costco-monitor`.
- [x] Confirm Costco customer warehouse-inventory capability.
- [x] Identify Costco search/product/warehouse API architecture from public implementations.
- [ ] Verify Costco API response behavior with Pokémon item numbers without authenticated/private access.
- [x] Identify initial Sacramento-area Costco warehouse numbers.
- [ ] Implement `scrapers/costco.js` against customer-facing data only.
- [ ] Add Costco config without enabling it by default.
- [ ] Integrate Costco into `monitor.js` and state comparison.
- [ ] Add warehouse-aware Discord formatting.
- [ ] Test from GitHub Actions; if blocked, test Oracle/home runtime.
- [ ] Merge only after a live availability response is verified.
