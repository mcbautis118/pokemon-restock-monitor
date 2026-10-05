const { fetchWarehouseItem } = require('./scrapers/costco');
const { sendDiscordNotification } = require('./notifiers/discord');

const ITEM_NUMBER = process.env.COSTCO_POC_ITEM || '2351582';
const WAREHOUSES = [
  { number: '438', name: 'Rancho Cordova' },
  { number: '464', name: 'Sacramento' },
  { number: '765', name: 'Folsom' },
  { number: '771', name: 'Citrus Heights' },
];

async function main() {
  console.log(`[POC] Costco item ${ITEM_NUMBER}`);
  const notifications = [];

  for (const warehouse of WAREHOUSES) {
    try {
      console.log(`[POC] Checking ${warehouse.name} #${warehouse.number}`);
      const product = await fetchWarehouseItem(ITEM_NUMBER, warehouse);

      if (!product) {
        console.log(`[POC] ${warehouse.name}: no catalogData returned`);
        continue;
      }

      console.log(`[POC] ${warehouse.name}: ${product.stockStatus}, price=${product.price}, inWarehouse=${product.inWarehouse}`);

      notifications.push({
        ...product,
        retailer: 'costco',
        name: `🧪 POC / TEST · ${product.name} · ${warehouse.name} #${warehouse.number}`,
        price: product.price == null ? 'N/A' : `$${product.price.toFixed(2)}`,
        priceNumeric: product.price,
        changeType: 'new',
      });
    } catch (err) {
      const status = err.response?.status;
      console.error(`[POC] ${warehouse.name}: ${status ? `HTTP ${status}: ` : ''}${err.message}`);
    }
  }

  if (!notifications.length) {
    console.error('[POC] Costco returned no usable warehouse records; no inventory notification can be truthfully sent.');
    process.exitCode = 2;
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
