const axios = require('axios');
const config = require('../config');

const PRODUCT_GRAPHQL_URL = 'https://ecom-api.costco.com/ebusiness/product/v1/products/graphql';
const PRODUCT_CLIENT_ID = '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf';

function buildProductQuery(itemNumber, warehouseNumber) {
  return `query {
    products(
      itemNumbers: ["${String(itemNumber).replace(/"/g, '')}"],
      clientId: "${PRODUCT_CLIENT_ID}",
      locale: "en-us",
      warehouseNumber: "${String(warehouseNumber).replace(/"/g, '')}"
    ) {
      catalogData {
        itemNumber
        itemId
        published
        buyable
        programTypes
        priceData { price listPrice }
        description { shortDescription }
      }
    }
  }`;
}

async function fetchWarehouseItem(itemNumber, warehouse) {
  const response = await axios.post(
    PRODUCT_GRAPHQL_URL,
    { query: buildProductQuery(itemNumber, warehouse.number) },
    {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        Origin: 'https://www.costco.com',
        Referer: 'https://www.costco.com/',
        'client-identifier': PRODUCT_CLIENT_ID,
        'costco.env': 'ecom',
        'costco.service': 'restProduct',
        'User-Agent': config.requestHeaders['User-Agent'],
      },
    }
  );

  const item = response.data?.data?.products?.catalogData?.[0];
  if (!item) return null;

  const programTypes = Array.isArray(item.programTypes) ? item.programTypes : [];
  const inWarehouse = programTypes.includes('WH');
  const available = item.buyable === 1 && inWarehouse;
  const rawPrice = item.priceData?.price;
  const priceNumber = rawPrice == null ? null : Number.parseFloat(rawPrice);

  return {
    id: `costco:${itemNumber}:${warehouse.number}`,
    sku: String(item.itemNumber || itemNumber),
    itemNumber: String(item.itemNumber || itemNumber),
    name: item.description?.shortDescription || `Costco item ${itemNumber}`,
    retailer: 'Costco',
    warehouseNumber: String(warehouse.number),
    warehouseName: warehouse.name,
    stockStatus: available ? 'in_stock' : 'out_of_stock',
    inWarehouse,
    price: Number.isFinite(priceNumber) ? priceNumber : null,
    url: `https://www.costco.com/p/-/${item.itemNumber || itemNumber}`,
    checkedAt: new Date().toISOString(),
  };
}

async function scrapeCostco() {
  const cfg = config.retailers.costco;
  const itemNumbers = cfg?.itemNumbers || [];
  const warehouses = cfg?.warehouses || [];

  if (!itemNumbers.length) {
    console.log('[Costco] No COSTCO_ITEM_NUMBERS configured — skipping');
    return [];
  }

  if (!warehouses.length) {
    console.log('[Costco] No warehouses configured — skipping');
    return [];
  }

  console.log(`[Costco] Checking ${itemNumbers.length} item(s) across ${warehouses.length} warehouse(s)`);

  const products = [];

  // Keep requests sequential and lightly paced. Warehouse inventory does not
  // need high-frequency parallel traffic, and this reduces block/rate-limit risk.
  for (const itemNumber of itemNumbers) {
    for (const warehouse of warehouses) {
      try {
        const product = await fetchWarehouseItem(itemNumber, warehouse);
        if (product) {
          products.push(product);
          console.log(`[Costco] ${warehouse.name} #${warehouse.number} | ${product.stockStatus} | ${product.name}`);
        } else {
          console.log(`[Costco] ${warehouse.name} #${warehouse.number} | item ${itemNumber} not returned`);
        }
      } catch (err) {
        const status = err.response?.status;
        console.warn(`[Costco] ${warehouse.name} #${warehouse.number} item ${itemNumber} failed${status ? ` HTTP ${status}` : ''}: ${err.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  return products;
}

module.exports = { scrapeCostco, fetchWarehouseItem, buildProductQuery };
