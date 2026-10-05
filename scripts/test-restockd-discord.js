require('dotenv').config();

const { sendDiscordNotification } = require('../notifiers/discord');

async function main() {
  const test = {
    id: `restockd-poc-${Date.now()}`,
    retailer: 'community',
    changeType: 'community_alert',
    source: 'Restockd',
    name: 'TEST — Pokémon 30th Celebration ETB + Booster Bundle',
    store: 'Target',
    retailerHint: 'Target — Folsom, CA',
    location: 'Folsom, CA',
    stockStatus: 'reported',
    price: 'N/A',
    url: 'https://restockd.app/pokemon-in-store?retailer=target',
    confidence: 'Community reported — not Target inventory verified',
    publicDelayNote: 'Public Restockd web sightings may be delayed about 60 minutes.',
  };

  console.log('[Restockd POC] Sending controlled Sacramento-area Discord test…');
  const result = await sendDiscordNotification([test]);
  console.log(`[Restockd POC] Discord result: sent=${result.sent}, failed=${result.failed}`);
  if (!result.sent || result.failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(`[Restockd POC] Failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
