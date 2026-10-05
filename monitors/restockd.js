const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const FEEDS = [
  'https://restockd.app/pokemon-in-store?retailer=target',
  'https://restockd.app/pokemon-in-store?retailer=best-buy',
  'https://restockd.app/pokemon-in-store?retailer=walmart',
  'https://restockd.app/pokemon-in-store?retailer=costco',
];

const LOCAL_TERMS = [
  'sacramento', 'rancho cordova', 'folsom', 'citrus heights', 'elk grove',
  'roseville', 'rocklin', 'loomis', 'fair oaks', 'orangevale', 'carmichael',
  'west sacramento', 'davis', 'woodland', 'antelope', 'north highlands',
];

const STATE_FILE = path.join(__dirname, '..', 'data', 'restockd-seen.json');

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveSeen(seen) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify([...seen].slice(-2000), null, 2));
}

function normalizeText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function isLocal(text) {
  const s = normalizeText(text).toLowerCase();
  return LOCAL_TERMS.some(term => s.includes(term));
}

function retailerFromUrl(sourceUrl) {
  try {
    const value = new URL(sourceUrl).searchParams.get('retailer') || '';
    return value.split('-').map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(' ');
  } catch { return 'Retailer'; }
}

function rowToSighting($, row, sourceUrl) {
  const cells = $(row).find('th,td').map((_, cell) => normalizeText($(cell).text())).get().filter(Boolean);
  const text = normalizeText($(row).text());
  if (!text || cells.length < 2) return null;

  const lower = text.toLowerCase();
  if (/product.*store|store.*product|recent spots/i.test(text)) return null;

  const href = $(row).find('a[href]').first().attr('href');
  let url = sourceUrl;
  if (href) {
    try { url = new URL(href, 'https://restockd.app').toString(); } catch {}
  }

  const retailer = retailerFromUrl(sourceUrl);
  const product = cells[0] || text;
  const storeLocation = cells.slice(1).join(' | ');
  const key = `${retailer}|${cells.join('|')}`.toLowerCase();

  return {
    id: `restockd:${Buffer.from(key).toString('base64').slice(0, 100)}`,
    retailer: 'community',
    source: 'Restockd',
    name: product.slice(0, 240),
    title: product.slice(0, 240),
    store: retailer,
    location: storeLocation.slice(0, 240),
    stockStatus: lower.includes('sold out') ? 'out_of_stock' : 'reported',
    changeType: 'community_alert',
    url,
    redditUrl: null,
    price: 'N/A',
    publicDelayNote: 'Restockd public web sightings may be delayed about 60 minutes.',
    confidence: 'Community reported — not retailer inventory verified',
    rawText: text,
    cells,
    key,
  };
}

// Parse all public "Recent spots" table rows first. Local filtering is intentionally
// separate so diagnostics can distinguish "parser found nothing" from "no local spots".
function extractAllSightings(html, sourceUrl) {
  const $ = cheerio.load(html);
  const results = [];
  const keys = new Set();

  $('table tbody tr').each((_, row) => {
    const sighting = rowToSighting($, row, sourceUrl);
    if (!sighting || keys.has(sighting.key)) return;
    keys.add(sighting.key);
    results.push(sighting);
  });

  // Fallback for responsive/non-table markup: inspect repeated rows that expose
  // multiple direct text cells. This does not apply the Sacramento filter.
  if (!results.length) {
    $('[role="row"]').each((_, row) => {
      const sighting = rowToSighting($, row, sourceUrl);
      if (!sighting || keys.has(sighting.key)) return;
      keys.add(sighting.key);
      results.push(sighting);
    });
  }

  return results;
}

function extractSightings(html, sourceUrl) {
  return extractAllSightings(html, sourceUrl).filter(s => isLocal(`${s.location} ${s.rawText}`));
}

async function scrapeRestockd() {
  const seen = loadSeen();
  const fresh = [];
  let fetched = 0;

  for (const url of FEEDS) {
    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PokemonTCGMonitor/1.0)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      const sightings = extractSightings(data, url);
      fetched += sightings.length;
      for (const s of sightings) {
        if (seen.has(s.key)) continue;
        seen.add(s.key);
        fresh.push(s);
      }
    } catch (err) {
      console.warn(`[Restockd] ${url}: ${err.response?.status || err.message}`);
    }
  }

  saveSeen(seen);
  console.log(`[Restockd] ${fetched} Sacramento-area public sighting(s), ${fresh.length} new`);
  return fresh;
}

module.exports = { scrapeRestockd, extractSightings, extractAllSightings, isLocal };
