const axios = require('axios');
const config = require('../config');

const PRODUCT_GRAPHQL_URL = 'https://ecom-api.costco.com/ebusiness/product/v1/products/graphql';
const SEARCH_URL = 'https://gdx-api.costco.com/catalog/search/api/v1/search';
const PRODUCT_CLIENT_ID = '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf';
const SEARCH_CLIENT_ID = '168287ea-1201-45f6-9b45-5bbea49f8ee7';

function buildProductQuery(itemNumber, warehouseNumber) {
  return `query {
    products(
      itemNumbers: ["${String(itemNumber).replace(/"/g, '')}"],
      clientId: "${PRODUCT_CLIENT_ID}",
      locale: "en-us",
      warehouseNumber: "${String(warehouseNumber).replace(/"/g, '')}"
    ) {
      catalogData {
        itemNumber itemId published buyable programTypes
        priceData { price listPrice }
        description { shortDescription }
      }
    }
  }`;
}

function flattenSearchSignals(result) {
  const product = result?.product || {};
  const attrs = product.attributes || {};
  const parts = [];
  const walk = value => {
    if (value == null) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(product.pills);
  walk(result.pills);
  walk(attrs);
  return parts.join(' | ');
}

function inventoryStatusFromSignals(text) {
  const value = String(text || '').toLowerCase();
  if (/\bout[ -]?of[ -]?stock\b|\bsold[ -]?out\b/.test(value)) return 'out_of_stock';
  if (/\blow[ -]?stock\b|\blimited[ -]?stock\b/.test(value)) return 'low_stock';
  if (/\bin[ -]?stock\b|\bavailable[ -]?in[ -]?warehouse\b/.test(value)) return 'in_stock';
  return 'unknown';
}

async function fetchWarehouseSearchSignal(itemNumber, warehouse) {
  const warehouseId = `${warehouse.number}-wh`;
  const body = {
    visitorId: '0',
    query: String(itemNumber),
    pageSize: 24,
    offset: 0,
    searchMode: 'page',
    personalizationEnabled: false,
    warehouseId,
    shipToPostal: warehouse.zip || '95670',
    shipToState: warehouse.state || 'CA',
    deliveryLocations: [warehouseId],
    filterBy: [],
    pageCategories: [],
    userInfo: { userId: '0' },
  };

  const response = await axios.post(SEARCH_URL, body, {
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://www.costco.com',
      Referer: 'https://www.costco.com/',
      'client-identifier': SEARCH_CLIENT_ID,
      client_id: 'USBC',
      locale: 'en-US',
      searchresultprovider: 'GRS',
      'User-Agent': config.requestHeaders['User-Agent'],
    },
  });

  const results = response.data?.searchResult?.results || [];
  const exact = results.find(r => String(r?.id || r?.product?.itemNumber || '') === String(itemNumber));
  if (!exact) return { status: 'unknown', signals: '', found: false };
  const signals = flattenSearchSignals(exact);
  return { status: inventoryStatusFromSignals(signals), signals, found: true };
}

async function fetchWarehouseItem(itemNumber, warehouse) {
  const [catalogResult, inventoryResult] = await Promise.allSettled([
    axios.post(PRODUCT_GRAPHQL_URL, { query: buildProductQuery(itemNumber, warehouse.number) }, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json', Accept: '*/*', Origin: 'https://www.costco.com',
        Referer: 'https://www.costco.com/', 'client-identifier': PRODUCT_CLIENT_ID,
        'costco.env': 'ecom', 'costco.service': 'restProduct',
        'User-Agent': config.requestHeaders['User-Agent'],
      },
    }),
    fetchWarehouseSearchSignal(itemNumber, warehouse),
  ]);

  const item = catalogResult.status === 'fulfilled'
    ? catalogResult.value.data?.data?.products?.catalogData?.[0]
    : null;
  const inv = inventoryResult.status === 'fulfilled'
    ? inventoryResult.value
    : { status: 'unknown', signals: '', found: false };

  if (!item && !inv.found) return null;

  const programTypes = Array.isArray(item?.programTypes) ? item.programTypes : [];
  const inWarehouse = programTypes.includes('WH') || programTypes.includes('InWarehouse');
  const rawPrice = item?.priceData?.price;
  const priceNumber = rawPrice == null ? null : Number.parseFloat(rawPrice);

  // Important: GraphQL `buyable` describes commerce eligibility and is NOT a
  // trustworthy warehouse on-hand count. Only label stock when Costco's
  // warehouse-scoped search response explicitly exposes a stock signal.
  const stockStatus = inv.status;

  return {
    id: `costco:${itemNumber}:${warehouse.number}`,
    sku: String(item?.itemNumber || itemNumber),
    itemNumber: String(item?.itemNumber || itemNumber),
    name: item?.description?.shortDescription || `Costco item ${itemNumber}`,
    retailer: 'Costco',
    warehouseNumber: String(warehouse.number),
    warehouseName: warehouse.name,
    stockStatus,
    inventorySource: inv.found ? 'costco_warehouse_search' : 'catalog_only',
    inventorySignals: inv.signals,
    inWarehouse,
    buyable: item?.buyable === 1,
    price: Number.isFinite(priceNumber) ? priceNumber : null,
    url: `https://www.costco.com/p/-/${item?.itemNumber || itemNumber}`,
    checkedAt: new Date().toISOString(),
  };
}

async function scrapeCostco() {
  const cfg = config.retailers.costco;
  const itemNumbers = cfg?.itemNumbers || [];
  const warehouses = cfg?.warehouses || [];
  if (!itemNumbers.length) { console.log('[Costco] No COSTCO_ITEM_NUMBERS configured — skipping'); return []; }
  if (!warehouses.length) { console.log('[Costco] No warehouses configured — skipping'); return []; }

  console.log(`[Costco] Checking ${itemNumbers.length} item(s) across ${warehouses.length} warehouse(s)`);
  const products = [];
  for (const itemNumber of itemNumbers) {
    for (const warehouse of warehouses) {
      try {
        const product = await fetchWarehouseItem(itemNumber, warehouse);
        if (product) {
          products.push(product);
          console.log(`[Costco] ${warehouse.name} #${warehouse.number} | ${product.stockStatus} | source=${product.inventorySource} | ${product.name}`);
        } else console.log(`[Costco] ${warehouse.name} #${warehouse.number} | item ${itemNumber} not returned`);
      } catch (err) {
        const status = err.response?.status;
        console.warn(`[Costco] ${warehouse.name} #${warehouse.number} item ${itemNumber} failed${status ? ` HTTP ${status}` : ''}: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  return products;
}

module.exports = { scrapeCostco, fetchWarehouseItem, fetchWarehouseSearchSignal, buildProductQuery, inventoryStatusFromSignals };
