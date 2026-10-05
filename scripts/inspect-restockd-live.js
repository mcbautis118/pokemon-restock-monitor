require('dotenv').config();

const axios = require('axios');
const { extractSightings } = require('../monitors/restockd');

const FEEDS = [
  'https://restockd.app/pokemon-in-store?retailer=target',
  'https://restockd.app/pokemon-in-store?retailer=best-buy',
  'https://restockd.app/pokemon-in-store?retailer=walmart',
  'https://restockd.app/pokemon-in-store?retailer=costco',
];

async function main() {
  let total = 0;
  console.log('[Restockd LIVE] Inspection only — NO Discord notifications will be sent.');

  for (const url of FEEDS) {
    console.log(`\n[Restockd LIVE] Fetching ${url}`);
    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PokemonTCGMonitor/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      const sightings = extractSightings(data, url);
      console.log(`[Restockd LIVE] Sacramento-area matches: ${sightings.length}`);
      total += sightings.length;

      sightings.forEach((s, i) => {
        console.log(JSON.stringify({
          n: i + 1,
          store: s.store,
          location: s.location,
          status: s.stockStatus,
          name: s.name,
          url: s.url,
        }, null, 2));
      });
    } catch (err) {
      console.error(`[Restockd LIVE] Fetch failed: ${err.response?.status || err.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\n[Restockd LIVE] Done. ${total} Sacramento-area sighting block(s) extracted.`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
