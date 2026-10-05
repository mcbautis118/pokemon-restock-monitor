const { fetchWarehouseItem } = require('./scrapers/costco');
const { sendDiscordNotification } = require('./notifiers/discord');

const ITEM_NUMBER = process.env.COSTCO_POC_ITEM || '2351582';
const WAREHOUSES = [
  { number: '438', name: 'Rancho Cordova', zip: '95742', state: 'CA' },
  { number: '464', name: 'Sacramento', zip: '95823', state: 'CA' },
  { number: '765', name: 'Folsom', zip: '95630', state: 'CA' },
  { number: '771', name: 'Citrus Heights', zip: '95610', state: 'CA' },
];

const CONFIRMED_STATUSES = new Set(['in_stock', 'out_of_stock', 'pre_order']);

async function main() {
  console.log(`[POC] Costco item ${ITEM_NUMBER}`);
  const notifications = [];
  let unknownCount = 0;

  for (const warehouse of WAREHOUSES) {
    try {
      console.log(`[POC] Checking ${warehouse.name} #${warehouse.number}`);
      const product = await fetchWarehouseItem(ITEM_NUMBER, warehouse);
      if (!product) {
        console.log(`[POC] ${warehouse.name}: no usable Costco record`);
        continue;
      }

      console.log(`[POC] ${warehouse.name}: status=${product.stockStatus}, source=${product.inventorySource}, buyable=${product.buyable}, inWarehouse=${product.inWarehouse}, price=${product.price}`);
      if (product.inventorySignals) console.log(`[POC] ${warehouse.name} signals: ${product.inventorySignals.slice(0, 800)}`);

      // Safety rule: catalog-only/buyable data does NOT prove warehouse stock.
      // Never send a Discord stock alert unless Costco returned a warehouse-scoped
      // signal that we could classify explicitly.
      if (!CONFIRMED_STATUSES.has(product.stockStatus) || product.inventorySource !== 'costco_warehouse_search') {
        unknownCount++;
        console.log(`[POC] ${warehouse.name}: inventory NOT CONFIRMED — suppressing Discord stock alert`);
        continue;
      }

      notifications.push({
        ...product,
        retailer: 'costco',
        name: `🧪 LIVE INVENTORY TEST · ${product.name} · ${warehouse.name} #${warehouse.number}`,
        price: product.price == null ? 'N/A' : `$${product.price.toFixed(2)}`,
        priceNumeric: product.price,
        changeType: 'new',
      });
    } catch (err) {
      const status = err.response?.status;
      console.error(`[POC] ${warehouse.name}: ${status ? `HTTP ${status}: ` : ''}${err.message}`);
    }
  }

  console.log(`[POC] Summary: ${notifications.length} confirmed warehouse result(s), ${unknownCount} unknown/suppressed`);

  if (!notifications.length) {
    console.log('[POC] No confirmed warehouse inventory results. No Discord stock alert sent (prevents false positives).');
    return;
  }

  const result = await sendDiscordNotification(notifications);
  console.log(`[POC] Discord result: sent=${result.sent}, failed=${result.failed}`);
  if (!result.sent) process.exitCode = 3;
}

main().catch(err => {
  console.error(`[POC] Fatal: ${err.stack || err.message}`);
  process.exitCode = 1;
});
