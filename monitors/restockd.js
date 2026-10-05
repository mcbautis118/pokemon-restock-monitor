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

function isLocal(text) {
  const s = String(text || '').toLowerCase();
  return LOCAL_TERMS.some(term => s.includes(term));
}

function normalizeText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function extractSightings(html, sourceUrl) {
  const $ = cheerio.load(html);
  const results = [];
  const seenText = new Set();

  // Restockd's public page can change markup, so inspect card/article/list-like
  // containers and keep only blocks that clearly contain a Sacramento-area place.
  $('article, li, [class*="card"], [class*="sighting"], [class*="stock"], [class*="store"]').each((_, el) => {
    const text = normalizeText($(el).text());
    if (text.length < 15 || text.length > 1600 || !isLocal(text) || seenText.has(text)) return;
    seenText.add(text);

    const href = $(el).find('a[href]').first().attr('href');
    let url = sourceUrl;
    if (href) {
      try { url = new URL(href, 'https://restockd.app').toString(); } catch {}
    }

    const lower = text.toLowerCase();
    const retailer = lower.includes('target') ? 'Target'
      : lower.includes('best buy') ? 'Best Buy'
      : lower.includes('walmart') ? 'Walmart'
      : lower.includes('costco') ? 'Costco'
      : 'Retailer';

    const location = LOCAL_TERMS.find(term => lower.includes(term)) || 'Sacramento area';
    const key = `${retailer}|${location}|${text}`.toLowerCase();

    results.push({
      id: `restockd:${Buffer.from(key).toString('base64').slice(0, 80)}`,
      retailer: 'community',
      source: 'Restockd',
      name: text.slice(0, 240),
      title: text.slice(0, 240),
      store: retailer,
      location,
      stockStatus: lower.includes('sold out') ? 'out_of_stock' : 'reported',
      changeType: 'community_alert',
      url,
      redditUrl: null,
      price: 'N/A',
      publicDelayNote: 'Restockd public web sightings may be delayed about 60 minutes.',
      confidence: 'Community reported — not retailer inventory verified',
      rawText: text,
      key,
    });
  });

  return results;
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
  console.log(`[Restockd] ${fetched} Sacramento-area public sighting block(s), ${fresh.length} new`);
  return fresh;
}

module.exports = { scrapeRestockd, extractSightings, isLocal };
