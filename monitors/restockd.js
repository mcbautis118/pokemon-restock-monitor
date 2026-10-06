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

const MAX_ALERT_AGE_MINUTES = 180;
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

function cleanProductName(product) {
  return normalizeText(product)
    .replace(/^Reported near store\s*/i, '')
    .replace(/\s*·\s*posted from the store\s*$/i, '')
    .replace(/Pokémon\s*$/i, '')
    .trim();
}

function parseAge(ageText) {
  const text = normalizeText(ageText).toLowerCase();
  if (!text) return { ageText: null, ageMinutes: null };
  if (/^(just now|now|moments? ago)$/.test(text)) return { ageText: normalizeText(ageText), ageMinutes: 0 };

  const match = text.match(/(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*ago/);
  if (!match) return { ageText: normalizeText(ageText), ageMinutes: null };

  const value = Number(match[1]);
  const unit = match[2];
  let multiplier = 1;
  if (/^(h|hr|hrs|hour|hours)$/.test(unit)) multiplier = 60;
  if (/^(d|day|days)$/.test(unit)) multiplier = 1440;
  return { ageText: normalizeText(ageText), ageMinutes: value * multiplier };
}

function freshnessForAge(ageMinutes) {
  if (ageMinutes == null) return { freshness: 'UNKNOWN AGE', freshnessEmoji: '⚪' };
  if (ageMinutes <= 15) return { freshness: 'VERY FRESH', freshnessEmoji: '🚨' };
  if (ageMinutes <= 30) return { freshness: 'FRESH', freshnessEmoji: '🔥' };
  if (ageMinutes <= 60) return { freshness: 'RECENT', freshnessEmoji: '🟡' };
  if (ageMinutes <= MAX_ALERT_AGE_MINUTES) return { freshness: 'OLDER REPORT', freshnessEmoji: '⚪' };
  return { freshness: 'STALE', freshnessEmoji: '⏳' };
}

function parseStatus(statusText) {
  const text = normalizeText(statusText);
  const lower = text.toLowerCase();
  const hasInStock = lower.includes('in stock');
  const hasSoldOut = lower.includes('sold out');
  const isClosed = lower.includes('closed');

  if (isClosed) return { stockStatus: 'closed', statusLabel: '🔒 Closed', alertable: false };
  if (hasInStock && hasSoldOut) return { stockStatus: 'mixed', statusLabel: '🟡 Mixed reports: In Stock + Sold Out', alertable: true };
  if (hasInStock) return { stockStatus: 'reported', statusLabel: '🟢 Reported In Stock', alertable: true };
  if (hasSoldOut) return { stockStatus: 'out_of_stock', statusLabel: '❌ Reported Sold Out', alertable: false };
  return { stockStatus: 'reported', statusLabel: text || '🟢 Community reported', alertable: true };
}

function rowToSighting($, row, sourceUrl) {
  const cells = $(row).find('th,td').map((_, cell) => normalizeText($(cell).text())).get().filter(Boolean);
  const text = normalizeText($(row).text());
  if (!text || cells.length < 2) return null;
  if (/product.*store|store.*product|recent spots/i.test(text)) return null;

  const href = $(row).find('a[href]').first().attr('href');
  let url = sourceUrl;
  if (href) {
    try { url = new URL(href, 'https://restockd.app').toString(); } catch {}
  }

  const retailer = retailerFromUrl(sourceUrl);
  const product = cleanProductName(cells[0] || text);

  const ageIndex = cells.findIndex((cell, index) => index > 0 && /(?:just now|now|moments? ago|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*ago)/i.test(cell));
  const statusIndex = cells.findIndex((cell, index) => index > 0 && /(in stock|sold out|closed)/i.test(cell));
  const ageSource = ageIndex >= 0 ? cells[ageIndex] : text.match(/(?:just now|moments? ago|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*ago)/i)?.[0];
  const statusSource = statusIndex >= 0 ? cells[statusIndex] : text.match(/(?:in stock.*?sold out|in stock|sold out|closed)/i)?.[0] || '';

  const excluded = new Set([0, ageIndex, statusIndex].filter(i => i >= 0));
  const locationCells = cells.filter((_, index) => !excluded.has(index));
  const storeLocation = locationCells.join(' | ') || cells.slice(1).join(' | ');

  const { ageText, ageMinutes } = parseAge(ageSource);
  const freshness = freshnessForAge(ageMinutes);
  const status = parseStatus(statusSource);
  const alertable = status.alertable && (ageMinutes == null || ageMinutes <= MAX_ALERT_AGE_MINUTES);
  const key = `${retailer}|${cells.join('|')}`.toLowerCase();

  return {
    id: `restockd:${Buffer.from(key).toString('base64').slice(0, 100)}`,
    retailer: 'community',
    source: 'Restockd',
    name: product.slice(0, 240),
    title: product.slice(0, 240),
    store: retailer,
    location: storeLocation.slice(0, 240),
    stockStatus: status.stockStatus,
    statusLabel: status.statusLabel,
    reportAge: ageText,
    ageMinutes,
    freshness: freshness.freshness,
    freshnessEmoji: freshness.freshnessEmoji,
    alertable,
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
  let suppressed = 0;

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
        if (!s.alertable) {
          suppressed += 1;
          continue;
        }
        fresh.push(s);
      }
    } catch (err) {
      console.warn(`[Restockd] ${url}: ${err.response?.status || err.message}`);
    }
  }

  saveSeen(seen);
  console.log(`[Restockd] ${fetched} Sacramento-area public sighting(s), ${fresh.length} new alertable, ${suppressed} stale/closed/sold-out suppressed`);
  return fresh;
}

module.exports = {
  scrapeRestockd,
  extractSightings,
  extractAllSightings,
  isLocal,
  cleanProductName,
  parseAge,
  parseStatus,
  freshnessForAge,
  MAX_ALERT_AGE_MINUTES,
};
