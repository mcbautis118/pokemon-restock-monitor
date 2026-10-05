require('dotenv').config();

const axios = require('axios');
const { extractAllSightings, isLocal } = require('../monitors/restockd');

const FEEDS = [
  'https://restockd.app/pokemon-in-store?retailer=target',
  'https://restockd.app/pokemon-in-store?retailer=best-buy',
  'https://restockd.app/pokemon-in-store?retailer=walmart',
  'https://restockd.app/pokemon-in-store?retailer=costco',
];

function looksCalifornia(s) {
  const text = `${s.location || ''} ${s.rawText || ''}`.toLowerCase();
  return /\bca\b|california/.test(text);
}

async function main() {
  let total = 0;
  let californiaTotal = 0;
  let localTotal = 0;
  const samples = [];

  console.log('[Restockd LIVE V2] Inspection only — NO Discord notifications will be sent.');
  console.log('[Restockd LIVE V2] Parse nationwide first, then filter California and Sacramento area.');

  for (const url of FEEDS) {
    console.log(`\n[Restockd LIVE V2] Fetching ${url}`);
    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PokemonTCGMonitor/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      const all = extractAllSightings(data, url);
      const california = all.filter(looksCalifornia);
      const local = all.filter(s => isLocal(`${s.location} ${s.rawText}`));

      total += all.length;
      californiaTotal += california.length;
      localTotal += local.length;

      console.log(`[Restockd LIVE V2] Parsed: ${all.length} | California: ${california.length} | Sacramento-area: ${local.length}`);

      for (const s of all.slice(0, 3)) {
        samples.push({ retailer: s.store, product: s.name, location: s.location, raw: s.rawText.slice(0, 300) });
      }

      if (local.length) {
        console.log('[Restockd LIVE V2] Sacramento-area matches:');
        local.forEach((s, i) => console.log(JSON.stringify({
          n: i + 1,
          retailer: s.store,
          product: s.name,
          location: s.location,
          status: s.stockStatus,
          url: s.url,
        }, null, 2)));
      }
    } catch (err) {
      console.error(`[Restockd LIVE V2] Fetch failed: ${err.response?.status || err.message}`);
      process.exitCode = 1;
    }
  }

  console.log('\n[Restockd LIVE V2] SAMPLE REAL ROWS (up to 3 per retailer):');
  samples.forEach((s, i) => console.log(`${i + 1}. ${JSON.stringify(s)}`));

  console.log(`\n[Restockd LIVE V2] TOTALS: parsed=${total}, California=${californiaTotal}, Sacramento-area=${localTotal}`);
  if (total === 0) {
    console.error('[Restockd LIVE V2] ERROR: zero nationwide rows parsed. HTML structure still does not match parser.');
    process.exitCode = 2;
  } else {
    console.log('[Restockd LIVE V2] PASS: real public sighting rows were parsed.');
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
