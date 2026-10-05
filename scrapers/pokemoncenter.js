/**
 * Pokemon Center scraper + queue detector.
 *
 * ─── TWO JOBS ──────────────────────────────────────────────────────────────────
 *
 * 1. QUEUE DETECTION  (always runs, no credentials needed)
 *    Pokemon Center uses Queue-it to throttle access during major drops.
 *    Queue-it is a separate CDN (queue-it.net) with no Imperva protection, so
 *    we can poll it directly.
 *
 *    Detection methods (in order of reliability):
 *      a. Queue-it domain poll — pokemoncenter.queue-it.net returns 404 when
 *         idle. Any 200/302/redirect response signals an active queue.
 *      b. Product-page redirect — On heavy drops Pokemon Center's server-side
 *         Queue-it connector fires BEFORE Imperva and returns a 302 to queue-it.net.
 *         We follow redirects on watched product URLs and check the final host.
 *      c. Page content probe — If we get through Imperva (cookie mode), parse
 *         the page for Queue-it configuration embedded in the JavaScript.
 *
 *    When a queue is detected the scraper emits a queueEvent object that
 *    monitor.js routes to the CRITICAL notification path.
 *
 * 2. PRODUCT SCRAPING  (requires PC_COOKIE — see below)
 *    Pokemon Center uses Imperva (Distil) on HTML pages and DataDome on its
 *    JSON API; both challenge and block datacenter IPs. With a valid Imperva
 *    cookie the HTML path works; without it the scraper returns [] for products
 *    and logs a clear message rather than crashing.
 *
 * ─── GETTING A VALID COOKIE ────────────────────────────────────────────────────
 *    1. Open pokemoncenter.com in Chrome (any residential connection)
 *    2. DevTools → Network → filter "pokemoncenter.com"
 *    3. Right-click any request → Copy → Copy as cURL
 *    4. From the copied command, extract the Cookie: header value
 *    5. Set PC_COOKIE=<that entire cookie string> in .env and as a GitHub Secret
 *    The cookie typically stays valid for 24-72 hours before Imperva rotates it.
 *
 * ─── WATCHED PRODUCT URLS ──────────────────────────────────────────────────────
 *    Set PC_WATCH_URLS in .env (comma-separated Pokemon Center product URLs).
 *    These are checked for Queue-it redirects every run.
 *    Example:
 *      PC_WATCH_URLS=https://www.pokemoncenter.com/product/pokemon-tcg-destined-rivals-elite-trainer-box/290-80087,...
 *
 * ─── QUEUE-IT CUSTOMER IDs ─────────────────────────────────────────────────────
 *    Pokemon Center's Queue-it customer ID is tried in order:
 *      pokemoncenter, pokemon, tpci
 *    All three resolve to Queue-it CDN infrastructure. Any 200 response from
 *    any candidate indicates a live queue.
 *    Override via: PC_QUEUEIT_IDS=pokemoncenter,pokemon
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');
const { withRetry, sleep } = require('../utils/retry');

// ── Constants ─────────────────────────────────────────────────────────────────

const PC_BASE          = 'https://www.pokemoncenter.com';
const QUEUEIT_BASE     = 'queue-it.net';
const HISTORY_FILE     = path.resolve('./data/pc-queue-history.json');

const QUEUEIT_CUSTOMER_IDS = (process.env.PC_QUEUEIT_IDS || 'pokemoncenter,pokemon,tpci')
  .split(',').map(s => s.trim()).filter(Boolean);

// Queue-it URL paths to probe for each customer ID
const QUEUEIT_PROBE_PATHS = [
  '/',
  '/waiting-room/',
  '/inqueue/',
  '/spa-api/queue/{cid}/status',
];

const REQUEST_TIMEOUT = 15000;
const DELAY_MS        = 1000;
const MAX_RETRIES     = 2;

// Pokemon Center category paths to scrape when cookies are valid
const PC_CATEGORIES = [
  '/category/trading-card-game',
  '/category/trading-card-game/booster-packs',
  '/category/trading-card-game/elite-trainer-boxes',
  '/category/trading-card-game/tins-and-collections',
  '/category/trading-card-game/theme-decks',
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function browserHeaders(extraHeaders = {}) {
  return {
    'User-Agent':                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':           'en-US,en;q=0.9',
    'Accept-Encoding':           'gzip, deflate, br',
    'Connection':                'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    ...extraHeaders,
  };
}

/**
 * Fetch a URL following redirects, returning status + finalUrl.
 * Used to detect when product pages redirect to queue-it.net.
 */
async function fetchFollowingRedirects(url, extraHeaders = {}) {
  return withRetry(
    async () => {
      const res = await axios.get(url, {
        headers:         browserHeaders(extraHeaders),
        timeout:         REQUEST_TIMEOUT,
        maxRedirects:    10,
        decompress:      true,
        validateStatus:  () => true,  // never throw on HTTP errors
      });

      // axios stores the final URL in res.request?.res?.responseUrl
      const finalUrl = res.request?.res?.responseUrl
        ?? res.request?.responseURL
        ?? url;

      return {
        status:   res.status,
        finalUrl,
        data:     res.data,
        headers:  res.headers,
      };
    },
    {
      maxAttempts: MAX_RETRIES,
      baseDelayMs: 1500,
      isRetryable(err) {
        return !err.response || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      },
      onRetry(err, attempt, delayMs) {
        console.warn(`[PC] Retry ${attempt} for ${url}: ${err.message} — waiting ${delayMs / 1000}s`);
      },
    },
  );
}

// ── Queue detection: Method A — Queue-it domain poll ─────────────────────────

/**
 * Poll Queue-it subdomains for Pokemon Center.
 * Returns a queue event if any probe returns non-404, else null.
 *
 * Queue-it's CDN: when no queue is active the subdomain returns 404 from
 * Queue-it's own infrastructure. Any other response (200, 302) indicates
 * a queue might be live for this customer.
 */
async function pollQueueItDomains() {
  for (const cid of QUEUEIT_CUSTOMER_IDS) {
    const baseHost = `https://${cid}.${QUEUEIT_BASE}`;

    for (const probePath of QUEUEIT_PROBE_PATHS) {
      const url = baseHost + probePath.replace('{cid}', cid);

      let result;
      try {
        result = await fetchFollowingRedirects(url);
      } catch (err) {
        console.warn(`[PC] Queue-it probe failed (${url}): ${err.message}`);
        continue;
      }

      const { status, finalUrl, data } = result;

      // 404 is the expected "no active queue" response from Queue-it
      if (status === 404) {
        console.log(`[PC] Queue-it ${cid} probe: 404 (no active queue)`);
        continue;
      }

      // Any non-404 from Queue-it's own infrastructure is potentially significant
      console.log(`[PC] Queue-it ${cid} probe: ${status} at ${finalUrl}`);

      // Parse queue content if we got HTML
      const parsed = parseQueueItPage(data, finalUrl);

      return {
        customerId:       cid,
        eventId:          parsed.eventId ?? extractEventId(finalUrl),
        queueUrl:         finalUrl,
        waitTime:         parsed.waitTime   ?? null,
        position:         parsed.position   ?? null,
        products:         parsed.products   ?? [],
        detectedAt:       new Date().toISOString(),
        detectionMethod:  'queueit_poll',
        httpStatus:       status,
      };
    }

    await sleep(300);
  }

  return null;
}

// ── Queue detection: Method B — Product page redirect check ───────────────────

/**
 * Fetch watched product URLs and check if they redirect to queue-it.net.
 * On heavy drops, Pokemon Center's server-side Queue-it connector issues
 * a 302 redirect BEFORE the Imperva challenge fires — making this detectable
 * via a plain HTTP client.
 *
 * Also works in cookie mode: if we have valid cookies and the page embeds
 * Queue-it JavaScript config, we extract the event details from it.
 */
async function checkProductPagesForQueue(watchUrls, cookie) {
  if (!watchUrls.length) return null;

  const headers = {};
  if (cookie) headers.Cookie = cookie;

  for (const productUrl of watchUrls) {
    let result;
    try {
      result = await fetchFollowingRedirects(productUrl, headers);
    } catch (err) {
      console.warn(`[PC] Product page check failed (${productUrl}): ${err.message}`);
      continue;
    }

    const { status, finalUrl, data } = result;

    // Queue-it server-side redirect: final URL is on queue-it.net
    if (finalUrl.includes(QUEUEIT_BASE)) {
      console.log(`[PC] ⚡ Queue-it redirect detected on product page!`);
      console.log(`[PC]    Source: ${productUrl}`);
      console.log(`[PC]    Redirected to: ${finalUrl}`);

      const parsed = parseQueueItPage(data, finalUrl);

      return {
        customerId:       extractCustomerId(finalUrl),
        eventId:          parsed.eventId  ?? extractEventId(finalUrl),
        queueUrl:         finalUrl,
        waitTime:         parsed.waitTime ?? null,
        position:         parsed.position ?? null,
        products:         parsed.products.length ? parsed.products : [productUrl],
        detectedAt:       new Date().toISOString(),
        detectionMethod:  'product_redirect',
        sourceProductUrl: productUrl,
      };
    }

    // Cookie mode: check page HTML for Queue-it JavaScript configuration
    if (cookie && status === 200 && typeof data === 'string') {
      const queueConfig = extractQueueItConfigFromHtml(data);
      if (queueConfig) {
        console.log(`[PC] ⚡ Queue-it config found in page JavaScript!`);
        return {
          customerId:       queueConfig.customerId,
          eventId:          queueConfig.eventId,
          queueUrl:         `https://${queueConfig.customerId}.${QUEUEIT_BASE}/`,
          waitTime:         null,
          position:         null,
          products:         [productUrl],
          detectedAt:       new Date().toISOString(),
          detectionMethod:  'page_content',
          sourceProductUrl: productUrl,
        };
      }

      // Also check if the page shows an in-page queue widget (iFrame or overlay)
      const queueWidget = detectQueueWidget(data);
      if (queueWidget) {
        return {
          ...queueWidget,
          detectedAt:      new Date().toISOString(),
          detectionMethod: 'page_widget',
          products:        [productUrl],
        };
      }
    }

    await sleep(500);
  }

  return null;
}

// ── Queue-it page parsing ─────────────────────────────────────────────────────

/**
 * Parse HTML from a Queue-it waiting room page.
 * Extracts: event ID, wait time, queue position, product name.
 */
function parseQueueItPage(html, pageUrl) {
  if (!html || typeof html !== 'string') return {};

  const result = {
    eventId:  extractEventId(pageUrl),
    waitTime: null,
    position: null,
    products: [],
  };

  try {
    const $ = cheerio.load(html);

    // Queue-it waiting room HTML patterns (may vary by Queue-it version)
    const waitSelectors = [
      '[data-queueit-c="WaitingRoomTimeLeft"]',
      '.queueit-time-left',
      '#WaitingRoomWaitingTime',
      '[id*="WaitingTime"]',
      '[class*="wait-time"]',
    ];
    for (const sel of waitSelectors) {
      const text = $(sel).first().text().trim();
      if (text) { result.waitTime = text; break; }
    }

    // Queue position
    const posSelectors = [
      '[data-queueit-c="WaitingRoomQueueNumber"]',
      '.queueit-queue-number',
      '#WaitingRoomQueueNumber',
      '[id*="QueueNumber"]',
      '[class*="queue-number"]',
    ];
    for (const sel of posSelectors) {
      const text = $(sel).first().text().trim();
      const num  = parseInt(text.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(num)) { result.position = num; break; }
    }

    // Product name (often in page title or description)
    const title = $('h1, h2, [class*="event-title"], [class*="waiting-for"]').first().text().trim();
    if (title && title.length > 3 && title.length < 200) {
      result.products = [title];
    }

    // Also look for "waiting for" or "you are in line for" patterns
    const bodyText = $.text().toLowerCase();
    const waitForMatch = bodyText.match(/(?:waiting for|in line for|queue for)[:\s]+([a-z0-9][^\n]+)/i);
    if (waitForMatch && !result.products.length) {
      result.products = [waitForMatch[1].trim().substring(0, 100)];
    }

    // Try JSON embedded in page scripts
    const scripts = $('script').map((_, el) => $(el).html()).get().join('\n');
    const jsonMatch = scripts.match(/"eventId"\s*:\s*"([^"]+)"/);
    if (jsonMatch && !result.eventId) result.eventId = jsonMatch[1];
    const waitMatch = scripts.match(/"waitingTimeText"\s*:\s*"([^"]+)"/);
    if (waitMatch) result.waitTime = waitMatch[1];
    const posMatch  = scripts.match(/"queueNumber"\s*:\s*(\d+)/);
    if (posMatch)  result.position = parseInt(posMatch[1], 10);

  } catch {
    // If cheerio fails, fall through with whatever we have
  }

  return result;
}

/**
 * Look for Queue-it JavaScript config embedded in Pokemon Center's page JS.
 * Queue-it integrations typically include a snippet like:
 *   QueueIT.queue({ c: 'pokemoncenter', e: 'event-id', ... })
 * or:
 *   window._queueConfig = { customerId: 'pokemoncenter', eventId: 'event-id' }
 */
function extractQueueItConfigFromHtml(html) {
  const patterns = [
    // Queue-it snippet patterns
    /QueueIT\.queue\s*\(\s*\{[^}]*c\s*:\s*['"]([^'"]+)['"]\s*,\s*e\s*:\s*['"]([^'"]+)['"]/i,
    /["']customerId["']\s*:\s*["']([^"']+)["'][^}]*["']eventId["']\s*:\s*["']([^"']+)["']/i,
    /["']c["']\s*:\s*["']([^"']+)["'][^}]*["']e["']\s*:\s*["']([^"']+)["']/i,
    /window\.__queueConfig\s*=\s*\{[^}]*customerId\s*:\s*["']([^"']+)["'][^}]*eventId\s*:\s*["']([^"']+)["']/i,
    // queue-it.net direct URLs embedded in scripts
    /https?:\/\/([a-z0-9-]+)\.queue-it\.net\/[^"'\s]*[?&]e=([a-z0-9_-]+)/i,
  ];

  for (const rx of patterns) {
    const m = html.match(rx);
    if (m && m[1] && m[2]) {
      return { customerId: m[1], eventId: m[2] };
    }
  }
  return null;
}

/**
 * Detect Queue-it in-page widget (iFrame, overlay div, or status message).
 */
function detectQueueWidget(html) {
  const lower = html.toLowerCase();
  const queuePhrases = [
    'you are in a queue',
    'you are in line',
    'your position in queue',
    'queue position',
    'estimated wait time',
    'waiting room',
    'queue is full',
    'you have been placed in a queue',
  ];

  const foundPhrase = queuePhrases.find(p => lower.includes(p.toLowerCase()));
  if (!foundPhrase) return null;

  // Extract customer/event ID from iFrame src or script src
  const iframeSrcMatch = html.match(/src=["']https?:\/\/([a-z0-9-]+)\.queue-it\.net([^"']*)/i);
  if (iframeSrcMatch) {
    const cid     = iframeSrcMatch[1];
    const params  = new URLSearchParams(iframeSrcMatch[2].split('?')[1] ?? '');
    const eid     = params.get('e') ?? null;
    const queueUrl = `https://${cid}.queue-it.net/`;
    return { customerId: cid, eventId: eid, queueUrl, phrase: foundPhrase };
  }

  return { customerId: null, eventId: null, queueUrl: null, phrase: foundPhrase };
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function extractEventId(url) {
  if (!url) return null;
  try {
    const params = new URL(url).searchParams;
    return params.get('e') ?? params.get('eventId') ?? params.get('event') ?? null;
  } catch {
    const m = url.match(/[?&]e=([a-z0-9_-]+)/i);
    return m ? m[1] : null;
  }
}

function extractCustomerId(url) {
  if (!url) return null;
  const m = url.match(/https?:\/\/([a-z0-9-]+)\.queue-it\.net/i);
  return m ? m[1] : 'pokemoncenter';
}

// ── Product scraping (JSON-LD) ────────────────────────────────────────────────

/**
 * Returns true when Pokemon Center's Imperva challenge was returned instead
 * of real content — this means the cookie is missing/expired.
 */
function isImpervaChallengeOrBlock(html) {
  if (!html || typeof html !== 'string') return false;
  return html.includes('Pardon Our Interruption')
    || html.includes('_Incapsula_Resource')
    || html.includes('captcha-delivery.com')
    || html.includes('window.onProtectionInitialized')
    || html.length < 5000;  // real product pages are much larger
}

/**
 * Extract products from Pokemon Center category pages.
 * Reuses the same __NEXT_DATA__ + Cheerio dual-strategy as msrpChecker.
 */
/**
 * Extract product-page URLs from a Pokemon Center category page.
 *
 * Pokemon Center currently renders product links in the category HTML even
 * when its old __NEXT_DATA__ product structure is empty or has changed.
 */
function extractProductUrlsFromCategory(html) {
  if (!html || typeof html !== 'string') return [];

  const $ = cheerio.load(html);
  const urls = new Set();

  $('a[href*="/product/"]').each((_, el) => {
    let href = $(el).attr('href');
    if (!href) return;

    try {
      const url = new URL(href, PC_BASE);

      if (url.hostname !== 'www.pokemoncenter.com' &&
          url.hostname !== 'pokemoncenter.com') {
        return;
      }

      if (!url.pathname.startsWith('/product/')) return;

      // Remove query strings / tracking parameters.
      url.search = '';
      url.hash = '';

      urls.add(url.toString());
    } catch {
      // Ignore malformed links.
    }
  });

  return [...urls];
}


/**
 * Convert schema.org availability into the monitor's stock-status format.
 */
function schemaAvailabilityToStockStatus(availability) {
  const value = String(availability || '').toLowerCase();

  if (value.includes('preorder') || value.includes('pre-order')) {
    return 'pre_order';
  }

  if (value.includes('instock') || value.includes('in_stock')) {
    return 'in_stock';
  }

  if (
    value.includes('outofstock') ||
    value.includes('out_of_stock') ||
    value.includes('soldout') ||
    value.includes('discontinued')
  ) {
    return 'out_of_stock';
  }

  return 'out_of_stock';
}


/**
 * Find Product objects inside JSON-LD.
 *
 * JSON-LD can be:
 *   { "@type": "Product" }
 *   [ ... ]
 *   { "@graph": [ ... ] }
 */
function findJsonLdProducts(value, results = []) {
  if (!value || typeof value !== 'object') return results;

  if (Array.isArray(value)) {
    for (const item of value) {
      findJsonLdProducts(item, results);
    }
    return results;
  }

  const type = value['@type'];

  if (
    type === 'Product' ||
    (Array.isArray(type) && type.includes('Product'))
  ) {
    results.push(value);
  }

  if (Array.isArray(value['@graph'])) {
    findJsonLdProducts(value['@graph'], results);
  }

  return results;
}


/**
 * Parse a Pokemon Center product page using its schema.org JSON-LD.
 */
function extractProductFromProductPage(html, pageUrl) {
  if (!html || typeof html !== 'string') return null;

  const $ = cheerio.load(html);
  const candidates = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html();
    if (!raw) return;

    try {
      const json = JSON.parse(raw);
      findJsonLdProducts(json, candidates);
    } catch {
      // Ignore malformed/unrelated JSON-LD blocks.
    }
  });

  if (!candidates.length) {
    return null;
  }

  // Normally there is one Product object.
  const product = candidates[0];

  let offer = product.offers;

  if (Array.isArray(offer)) {
    offer = offer[0];
  }

  // Some schema implementations wrap offers in AggregateOffer.
  if (offer?.offers && Array.isArray(offer.offers)) {
    offer = offer.offers[0];
  }

  const name =
    product.name ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  const sku =
    product.sku ||
    product.mpn ||
    '';

  const rawPrice =
    offer?.price ??
    offer?.lowPrice ??
    product.price ??
    null;

  const price =
    rawPrice != null
      ? parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''))
      : null;

  const availability =
    offer?.availability ||
    product.availability ||
    '';

  const stockStatus =
    schemaAvailabilityToStockStatus(availability);

  const canonical =
    product.url ||
    offer?.url ||
    $('link[rel="canonical"]').attr('href') ||
    pageUrl;

  if (!name) return null;

  const normalized = normalizeParsedProduct({
    name,
    price: Number.isFinite(price) ? price : null,
    url: canonical,
    stockStatus,
  });

  // Keep Pokemon Center's own SKU/MPN for debugging and future matching.
  normalized.sku = sku;

  return normalized;
}


/**
 * Fetch and parse one Pokemon Center product page.
 */
async function scrapeProductPage(productUrl, cookie = '') {
  const headers = {
    Referer: PC_BASE + '/',
  };

  if (cookie) {
    headers.Cookie = cookie;
  }

  let result;

  try {
    result = await fetchFollowingRedirects(productUrl, headers);
  } catch (err) {
    console.warn(`[PC] Product fetch failed (${productUrl}): ${err.message}`);
    return null;
  }

  const { status, finalUrl, data } = result;

  if (finalUrl.includes(QUEUEIT_BASE)) {
    console.log(`[PC] Product redirected to Queue-it: ${productUrl}`);
    return null;
  }

  if (status !== 200 && status !== 304) {
    console.warn(`[PC] Product returned HTTP ${status}: ${productUrl}`);
    return null;
  }

  if (isImpervaChallengeOrBlock(data)) {
    console.warn(`[PC] Product blocked/challenged: ${productUrl}`);
    return null;
  }

  const product = extractProductFromProductPage(data, productUrl);

  if (!product) {
    console.warn(`[PC] No Product JSON-LD found: ${productUrl}`);
    return null;
  }

  return product;
}


/**
 * Scrape Pokemon Center categories, discover product URLs, then inspect each
 * product's JSON-LD for authoritative availability.
 */
async function scrapeProductCatalog(cookie = '') {
  const discoveredUrls = new Set();
  const categoryHeaders = {
    Referer: PC_BASE + '/',
  };

  if (cookie) {
    categoryHeaders.Cookie = cookie;
  }

  // ── Phase 1: discover product URLs ──────────────────────────────────────────

  for (const categoryPath of PC_CATEGORIES) {
    let page = 1;

    while (page <= config.maxPages) {
      const url = `${PC_BASE}${categoryPath}?page=${page}`;

      let result;

      try {
        result = await fetchFollowingRedirects(url, categoryHeaders);
      } catch (err) {
        console.error(`[PC] Category fetch failed (${url}): ${err.message}`);
        break;
      }

      const { status, data, finalUrl } = result;

      if (finalUrl.includes(QUEUEIT_BASE)) {
        console.log(`[PC] Category redirected to Queue-it: ${url}`);
        break;
      }

      if (status !== 200 && status !== 304) {
        console.warn(`[PC] Category returned HTTP ${status}: ${url}`);
        break;
      }

      if (isImpervaChallengeOrBlock(data)) {
        console.warn(`[PC] Category blocked/challenged: ${url}`);
        break;
      }

      const urls = extractProductUrlsFromCategory(data);

      let newCount = 0;

      for (const productUrl of urls) {
        if (!discoveredUrls.has(productUrl)) {
          discoveredUrls.add(productUrl);
          newCount++;
        }
      }

      console.log(
        `[PC] ${categoryPath} page ${page}: ` +
        `${urls.length} product URLs (${newCount} new)`
      );

      if (!urls.length) break;

      // If another page gives us no new URLs, pagination has probably repeated.
      if (page > 1 && newCount === 0) break;

      page++;
      await sleep(DELAY_MS);
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `[PC] Discovered ${discoveredUrls.size} unique Pokemon Center product URLs`
  );

  // ── Phase 2: fetch product JSON-LD ──────────────────────────────────────────

  const products = [];
  let index = 0;

  for (const productUrl of discoveredUrls) {
    index++;

    console.log(
      `[PC] Product ${index}/${discoveredUrls.size}: ${productUrl}`
    );

    const product = await scrapeProductPage(productUrl, cookie);

    if (product) {
      products.push(product);

      console.log(
        `[PC]   ${product.stockStatus} | ${product.price} | ${product.name}`
      );
    }

    // Be polite to Pokemon Center and reduce bot-block risk.
    await sleep(350);
  }

  return products;
}

// ── Queue history ─────────────────────────────────────────────────────────────

function loadQueueHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, activeQueue: null, lastChecked: null, history: [] };
  }
}

function saveQueueHistory(history) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * Check whether the given queue event is genuinely NEW (not already known).
 * Returns true if the monitor should send a critical alert for it.
 */
function isNewQueueEvent(queueEvent, history) {
  if (!history.activeQueue) return true;  // nothing was active before

  // Same customer + event ID already known → not new
  if (
    history.activeQueue.customerId === queueEvent.customerId &&
    history.activeQueue.eventId    === queueEvent.eventId
  ) {
    return false;
  }

  // Different event ID → new event
  return true;
}

/**
 * Record a newly detected queue event. Returns whether it was new.
 */
function recordQueueEvent(queueEvent) {
  const history = loadQueueHistory();
  const isNew   = isNewQueueEvent(queueEvent, history);

  history.activeQueue  = queueEvent;
  history.lastChecked  = new Date().toISOString();

  if (isNew) {
    history.history.unshift({ ...queueEvent, closedAt: null });
    // Keep last 100 events
    if (history.history.length > 100) history.history = history.history.slice(0, 100);
  }

  saveQueueHistory(history);
  return isNew;
}

/**
 * Mark the active queue as closed (call when we no longer detect it).
 */
function closeActiveQueue() {
  const history = loadQueueHistory();
  if (!history.activeQueue) return false;

  console.log(`[PC] Queue closed — was active since ${history.activeQueue.detectedAt}`);

  if (history.history.length > 0 && !history.history[0].closedAt) {
    history.history[0].closedAt = new Date().toISOString();
  }

  history.activeQueue = null;
  history.lastChecked = new Date().toISOString();
  saveQueueHistory(history);
  return true;
}

function recordCheckedTime() {
  const history = loadQueueHistory();
  history.lastChecked = new Date().toISOString();
  saveQueueHistory(history);
}

// ── Main scraper ──────────────────────────────────────────────────────────────

/**
 * Run queue detection and (if cookie is set) product scraping.
 *
 * @returns {{
 *   queueEvent: object|null,   — queue alert data; null = no queue detected
 *   isNewQueue:  boolean,      — true = first time we saw this queue (alert!)
 *   products:    object[],     — normalized Pokemon Center products ([] without cookie)
 * }}
 */
async function scrapePokemonCenter() {
  const pcCfg    = config.retailers.pokemoncenter;
  const cookie   = pcCfg.cookie || '';
  const watchUrls = pcCfg.watchUrls ?? [];

  console.log('[PC] Starting Pokemon Center check');
  if (cookie) {
    console.log('[PC] Cookie set — authenticated mode (full product scraping enabled)');
  } else {
    console.log('[PC] No PC_COOKIE — queue detection enabled; product scraping will be attempted without cookie');
  }

  // ── Queue detection ─────────────────────────────────────────────────────────

  let queueEvent = null;

  // Method A: Queue-it domain poll
  if (pcCfg.queuePing !== false) {
    console.log(`[PC] Polling Queue-it subdomains: ${QUEUEIT_CUSTOMER_IDS.join(', ')}`);
    try {
      queueEvent = await pollQueueItDomains();
    } catch (err) {
      console.error(`[PC] Queue-it poll error: ${err.message}`);
    }
  }

  // Method B: Product page redirect check
  if (!queueEvent && watchUrls.length) {
    console.log(`[PC] Checking ${watchUrls.length} watched product URL(s) for queue redirects`);
    try {
      queueEvent = await checkProductPagesForQueue(watchUrls, cookie);
    } catch (err) {
      console.error(`[PC] Product page queue check error: ${err.message}`);
    }
  }

  // Record result and determine if this is a new queue vs previously known
  let isNewQueue = false;
  if (queueEvent) {
    isNewQueue = recordQueueEvent(queueEvent);
    if (isNewQueue) {
      console.log(`[PC] ⚡ NEW queue detected via ${queueEvent.detectionMethod}!`);
      console.log(`[PC]    Customer: ${queueEvent.customerId}  Event: ${queueEvent.eventId ?? 'unknown'}`);
      console.log(`[PC]    URL: ${queueEvent.queueUrl}`);
      if (queueEvent.position) console.log(`[PC]    Position: #${queueEvent.position}`);
      if (queueEvent.waitTime) console.log(`[PC]    Est. wait: ${queueEvent.waitTime}`);
    } else {
      console.log(`[PC] Queue still active (already known — no repeat alert)`);
    }
  } else {
    // No queue detected — close any previously recorded active queue
    closeActiveQueue();
    recordCheckedTime();
    console.log('[PC] No active queue detected');
  }

  // ── Product scraping (cookie required) ─────────────────────────────────────

let products = [];

{
  console.log(
    `[PC] Scraping product catalog via JSON-LD${cookie ? ' (cookie available)' : ' (no cookie)'}…`
  );

  try {
    products = await scrapeProductCatalog(cookie);

    const inStock    = products.filter(p => p.stockStatus === 'in_stock').length;
    const outOfStock = products.filter(p => p.stockStatus === 'out_of_stock').length;
    const preOrder   = products.filter(p => p.stockStatus === 'pre_order').length;

    console.log(
      `[PC] Catalog: ${products.length} products ` +
      `(${inStock} in-stock, ${outOfStock} OOS, ${preOrder} pre-order)`
    );
  } catch (err) {
    console.error(`[PC] Product scraping failed: ${err.message}`);
  }
}

  return { queueEvent, isNewQueue, products };
}

// ── Queue history summary ─────────────────────────────────────────────────────

function getQueueHistory() {
  return loadQueueHistory();
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// node scrapers/pokemoncenter.js               → check queue + scrape
// node scrapers/pokemoncenter.js --history     → print queue history
// node scrapers/pokemoncenter.js --queue-only  → queue check only (skip product scrape)

if (require.main === module) {
  require('dotenv').config();
  const args = process.argv.slice(2);

  if (args.includes('--history')) {
    const h = loadQueueHistory();
    console.log('\nPokemon Center Queue History');
    console.log('─'.repeat(70));
    console.log(`Last checked: ${h.lastChecked ?? 'never'}`);
    console.log(`Active queue: ${h.activeQueue ? JSON.stringify(h.activeQueue, null, 2) : 'none'}`);
    console.log(`\nPast events (${h.history.length}):`);
    for (const ev of h.history.slice(0, 10)) {
      const duration = ev.closedAt
        ? Math.round((new Date(ev.closedAt) - new Date(ev.detectedAt)) / 60000) + 'm'
        : 'ongoing';
      console.log(`  ${ev.detectedAt}  ${ev.customerId}/${ev.eventId ?? '?'}  (${duration})`);
    }
    console.log('─'.repeat(70));
    process.exit(0);
  }

  const queueOnly = args.includes('--queue-only');
  const origCfg = config.retailers.pokemoncenter;
  if (queueOnly) origCfg.cookie = '';  // disable product scraping

  scrapePokemonCenter()
    .then(({ queueEvent, isNewQueue, products }) => {
      console.log('\n' + '─'.repeat(70));
      console.log('Pokemon Center Check Results');
      console.log('─'.repeat(70));

      if (queueEvent) {
        console.log(`\n⚡ QUEUE ${isNewQueue ? 'NEWLY ' : ''}ACTIVE`);
        console.log(`   Customer ID: ${queueEvent.customerId}`);
        console.log(`   Event ID:    ${queueEvent.eventId ?? 'unknown'}`);
        console.log(`   Queue URL:   ${queueEvent.queueUrl}`);
        console.log(`   Method:      ${queueEvent.detectionMethod}`);
        if (queueEvent.position) console.log(`   Position:    #${queueEvent.position}`);
        if (queueEvent.waitTime) console.log(`   Est. wait:   ${queueEvent.waitTime}`);
        if (queueEvent.products?.length) {
          console.log(`   Products:    ${queueEvent.products.join(', ')}`);
        }
      } else {
        console.log('\n✓  No active queue');
      }

      if (products.length) {
        const sample = products.filter(p => p.stockStatus === 'in_stock').slice(0, 5);
        console.log(`\nProducts (${products.length} total, showing up to 5 in-stock):`);
        for (const p of sample) {
          console.log(`  [in-stock] ${p.price}  ${p.name}`);
          console.log(`             ${p.url}`);
        }
      } else if (!origCfg?.cookie) {
        console.log('\nProducts: skipped (no PC_COOKIE set — see file header for setup)');
      }

      console.log('\n' + '─'.repeat(70));
    })
    .catch(err => {
      console.error('[PC] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = {
  scrapePokemonCenter,
  getQueueHistory,
  pollQueueItDomains,
  checkProductPagesForQueue,
  parseQueueItPage,
  extractQueueItConfigFromHtml,
  isNewQueueEvent,
};
