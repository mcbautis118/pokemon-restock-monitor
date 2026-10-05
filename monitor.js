/**
 * monitor.js — Pokemon TCG restock monitor
 *
 * Enabled retailers:
 *   - Target
 *   - Walmart
 *   - Amazon
 *   - GameStop
 *
 * Pokémon Center:
 *   - Handled separately by scrapers/pokemoncenter.js
 *   - Queue detection remains enabled/controlled by config
 *   - Product scraping remains controlled by PC_COOKIE
 *
 * Run modes:
 *   (no flags)    Cron mode
 *   --once        Run once and exit
 *   --test, -t    Dry-run: scrape + compare, no notifications/state save
 *   --init        Force baseline initialization
 */

require('dotenv').config();

const config = require('./config');

// ─────────────────────────────────────────────────────────────────────────────
// MODULE REFERENCES
// ─────────────────────────────────────────────────────────────────────────────

const targetScraper   = require('./scrapers/target');
const walmartScraper  = require('./scrapers/walmart');
const amazonScraper   = require('./scrapers/amazon');
const bestbuyScraper  = require('./scrapers/bestbuy');
const gamestopScraper = require('./scrapers/gamestop');

const pcScraper       = require('./scrapers/pokemoncenter');
const redditMonitor   = require('./monitors/reddit');
const notifierMod     = require('./notifier');
const msrpMod         = require('./msrpChecker');
const stateMod        = require('./stateManager');

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

const DIVIDER = '━'.repeat(68);

const log = {
  divider: () => console.log(DIVIDER),

  phase: (n, total, msg) =>
    console.log(`\n[${n}/${total}] ${msg}`),

  info: (...args) =>
    console.log('     ', ...args),

  ok: (...args) =>
    console.log('   ✓', ...args),

  warn: (...args) =>
    console.warn('   ⚠', ...args),

  error: (...args) =>
    console.error('   ✗', ...args),

  item: (tag, msg) =>
    console.log(`     ${('[' + tag + ']').padEnd(12)} ${msg}`),

  blank: () =>
    console.log(''),
};

function elapsed(startMs) {
  const seconds = (Date.now() - startMs) / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIRST-RUN DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function isFirstRun(state) {
  return state.lastSaved === null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPER REGISTRY
//
// IMPORTANT:
// Barnes & Noble has been REMOVED.
// Best Buy is enabled through the scraper registry below.
//
// Pokémon Center is NOT included here because it has its own special
// queue-detection system and is handled separately below.
// ─────────────────────────────────────────────────────────────────────────────

const SCRAPERS = [
  {
    key: 'target',
    name: 'Target',
    fn: () => targetScraper.scrapeTarget(),
    cfg: () => config.retailers.target,
  },

  {
    key: 'walmart',
    name: 'Walmart',
    fn: () => walmartScraper.scrapeWalmart(),
    cfg: () => config.retailers.walmart,
  },

  {
    key: 'amazon',
    name: 'Amazon',
    fn: () => amazonScraper.scrapeAmazon(),
    cfg: () => config.retailers.amazon,
  },

    {
    key: 'bestbuy',
    name: 'Best Buy',
    fn: () => bestbuyScraper.scrapeBestBuy(),
    cfg: () => config.retailers.bestbuy,
  },
  
  {
    key: 'gamestop',
    name: 'GameStop',
    fn: () => gamestopScraper.scrapeGameStop(),
    cfg: () => config.retailers.gamestop,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — POKÉMON CENTER QUEUE CHECK
// ─────────────────────────────────────────────────────────────────────────────

async function checkPokemonCenterQueue(
  phaseNum,
  totalPhases,
  isDryRun
) {
  if (!config.retailers.pokemoncenter?.enabled) {
    log.phase(
      phaseNum,
      totalPhases,
      'Pokemon Center queue check [DISABLED]'
    );

    return;
  }

  log.phase(
    phaseNum,
    totalPhases,
    'Pokemon Center queue check'
  );

  const t0 = Date.now();

  let result;

  try {
    result = await pcScraper.scrapePokemonCenter();
  } catch (err) {
    log.warn(`Queue check failed — ${err.message}`);
    return;
  }

  const {
    queueEvent,
    isNewQueue,
    products,
  } = result;

  // No queue
  if (!queueEvent) {
    log.info(
      `No active queue detected (${elapsed(t0)})`
    );
  }

  // Queue detected
  else {
    const pos =
      queueEvent.position != null
        ? ` · position ${queueEvent.position}`
        : '';

    const wait =
      queueEvent.waitTime
        ? ` · wait ${queueEvent.waitTime}`
        : '';

    log.warn(
      `QUEUE DETECTED${pos}${wait} (${elapsed(t0)})`
    );

    // New queue
    if (isNewQueue) {
      if (isDryRun) {
        log.info(
          'Would send CRITICAL queue alert — suppressed by --test'
        );
      }

      else {
        log.info(
          'Sending CRITICAL queue alert to Telegram…'
        );

        try {
          const alertResults =
            await notifierMod.notifyCritical(queueEvent);

          for (
            const [channel, r]
            of Object.entries(alertResults)
          ) {
            if (r?.error) {
              log.error(`${channel}: ${r.error}`);
            }

            else if (r?.sent === false) {
              log.warn(
                `${channel}: not sent (check credentials)`
              );
            }

            else {
              log.ok(
                `${channel}: queue alert sent`
              );
            }
          }
        }

        catch (err) {
          log.error(
            `Queue notification failed: ${err.message}`
          );
        }
      }
    }

    // Queue already known
    else {
      log.info(
        'Queue already known from previous run — no duplicate alert'
      );
    }
  }

  if (products?.length) {
    log.info(
      `PC catalog: ${products.length} product(s)`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — MSRP DATABASE
// ─────────────────────────────────────────────────────────────────────────────

async function refreshMsrp(
  phaseNum,
  totalPhases
) {
  log.phase(
    phaseNum,
    totalPhases,
    'MSRP database'
  );

  const t0 = Date.now();

  try {
    const db =
      await msrpMod.updateMsrpDatabase();

    const age = db.lastUpdated
      ? Math.round(
          (
            Date.now() -
            new Date(db.lastUpdated).getTime()
          ) /
          1000 /
          60
        )
      : null;

    const ageStr =
      age !== null
        ? ` · ${
            age < 60
              ? age + 'm'
              : Math.round(age / 60) + 'h'
          } old`
        : '';

    log.ok(
      `${db.count} products${ageStr} (${elapsed(t0)})`
    );

    return db;
  }

  catch (err) {
    log.warn(
      `Update failed — using stale cache. ${err.message}`
    );

    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — RETAILER SCRAPING
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeRetailers(
  phaseNum,
  totalPhases
) {
  const enabled =
    SCRAPERS.filter(
      scraper => scraper.cfg()?.enabled
    );

  const disabled =
    SCRAPERS.filter(
      scraper => !scraper.cfg()?.enabled
    );

  log.phase(
    phaseNum,
    totalPhases,
    `Scraping retailers (${
      enabled.map(s => s.name).join(' + ') || 'none'
    } — parallel)`
  );

  if (disabled.length) {
    log.info(
      `Disabled: ${disabled
        .map(s => s.name)
        .join(', ')}`
    );
  }

  if (!enabled.length) {
    log.warn(
      'No retailers enabled — nothing to scrape.'
    );

    return [];
  }

  const settled =
    await Promise.allSettled(
      enabled.map(
        ({ key, name, fn }) => {
          const t0 = Date.now();

          return fn()
            .then(products => ({
              key,
              name,
              products,
              elapsedMs:
                Date.now() - t0,
              error: null,
            }))

            .catch(error => ({
              key,
              name,
              products: [],
              elapsedMs:
                Date.now() - t0,
              error,
            }));
        }
      )
    );

  const results =
    settled.map(
      result =>
        result.value ??
        result.reason
    );

  for (const result of results) {
    if (result.error) {
      log.error(
        `${result.name.padEnd(10)} failed — ${result.error.message}`
      );
    }

    else {
      log.ok(
        `${result.name.padEnd(10)} ${
          result.products.length
        } product(s) (${
          (result.elapsedMs / 1000).toFixed(1)
        }s)`
      );
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3B — REDDIT COMMUNITY ALERTS
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeRedditAlerts(
  phaseNum,
  totalPhases
) {
  if (
    process.env.REDDIT_ENABLED === 'false'
  ) {
    return [];
  }

  try {
    const posts =
      await redditMonitor.scrapeReddit();

    if (posts.length) {
      log.ok(
        `Reddit     ${posts.length} community alert(s)`
      );
    }

    return posts;
  }

  catch (err) {
    log.warn(
      `Reddit failed — ${err.message}`
    );

    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INITIAL BASELINE
// ─────────────────────────────────────────────────────────────────────────────

async function runInit(
  scraperResults,
  phaseNum,
  totalPhases
) {
  log.phase(
    phaseNum,
    totalPhases,
    'Baseline initialization (first run — no notifications)'
  );

  const byRetailer = {};

  for (const result of scraperResults) {
    if (!result.error) {
      byRetailer[result.key] =
        result.products;
    }
  }

  const summary =
    stateMod.initializeBaseline(
      byRetailer
    );

  const total =
    summary.reduce(
      (n, s) => n + s.count,
      0
    );

  for (const { retailer, count } of summary) {
    log.ok(
      `${retailer.padEnd(10)} ${count} products baselined`
    );
  }

  log.blank();

  log.info(
    `${total} total products saved as baseline. ` +
    `Next run will detect changes.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — COMPARISON
// ─────────────────────────────────────────────────────────────────────────────

function compareRetailers(
  scraperResults,
  state,
  phaseNum,
  totalPhases
) {
  log.phase(
    phaseNum,
    totalPhases,
    'Comparing against stored state'
  );

  const allNew = [];
  const allRestocked = [];

  let totalSeen = 0;

  for (const result of scraperResults) {
    if (result.error) {
      log.warn(
        `${result.name} — skipping comparison (scraper failed)`
      );

      continue;
    }

    totalSeen +=
      result.products.length;

    const {
      newProducts,
      restockedProducts,
    } =
      stateMod.compareAndUpdate(
        result.key,
        result.products,
        state
      );

    const newCount =
      newProducts.length;

    const restockCount =
      restockedProducts.length;

    if (newCount || restockCount) {
      const parts = [];

      if (newCount) {
        parts.push(
          `${newCount} new`
        );
      }

      if (restockCount) {
        parts.push(
          `${restockCount} restock`
        );
      }

      log.ok(
        `${result.name.padEnd(10)} ${
          result.products.length
        } seen · ${parts.join(' · ')}`
      );
    }

    else {
      log.info(
        `${result.name.padEnd(10)} ${
          result.products.length
        } seen · no changes`
      );
    }

    allNew.push(
      ...newProducts
    );

    allRestocked.push(
      ...restockedProducts
    );
  }

  return {
    allNew,
    allRestocked,
    totalSeen,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG FLAGGED PRODUCTS
// ─────────────────────────────────────────────────────────────────────────────

function logFlaggedProducts(
  allNew,
  allRestocked
) {
  if (
    !allNew.length &&
    !allRestocked.length
  ) {
    return;
  }

  log.blank();

  for (const product of allNew) {
    const msrpNote =
      product.msrp
        ? ` (MSRP ${product.msrp.msrpFormatted})`
        : '';

    log.item(
      'NEW',
      `${product.name}  ${
        product.price
      }${msrpNote}  ${
        product.url
      }`
    );
  }

  for (const product of allRestocked) {
    const wasLabel =
      product.previousStockStatus
        ?.replace(/_/g, ' ') ??
      'unknown';

    const msrpNote =
      product.msrp
        ? ` (MSRP ${product.msrp.msrpFormatted})`
        : '';

    log.item(
      'RESTOCK',
      `${product.name}  ${
        product.price
      }${msrpNote}  was: ${
        wasLabel
      }  ${
        product.url
      }`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

async function sendNotifications(
  toNotify,
  phaseNum,
  totalPhases,
  isDryRun
) {
  log.phase(
    phaseNum,
    totalPhases,
    `Notifications${
      isDryRun
        ? ' [DRY RUN — skipped]'
        : ''
    }`
  );

  if (!toNotify.length) {
    log.info(
      'Nothing to notify.'
    );

    return;
  }

  if (isDryRun) {
    log.info(
      `Would notify: ${
        toNotify.length
      } product(s) — suppressed by --test`
    );

    return;
  }

  try {
    const results =
      await notifierMod.notify(
        toNotify
      );

    for (
      const [channel, result]
      of Object.entries(results)
    ) {
      if (result?.error) {
        log.error(
          `${channel}: ${result.error}`
        );
      }

      else if (
        result?.sent === false
      ) {
        log.warn(
          `${channel}: not sent (check credentials)`
        );
      }

      else {
        log.ok(channel);
      }
    }
  }

  catch (err) {
    log.error(
      `Notification error: ${err.message}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — SAVE STATE
// ─────────────────────────────────────────────────────────────────────────────

function persistState(
  state,
  phaseNum,
  totalPhases,
  isDryRun
) {
  log.phase(
    phaseNum,
    totalPhases,
    `Save state${
      isDryRun
        ? ' [DRY RUN — skipped]'
        : ''
    }`
  );

  if (isDryRun) {
    log.info(
      'State not written — dry-run mode keeps state ephemeral.'
    );

    return;
  }

  stateMod.saveState(state);

  const rows =
    stateMod.summarizeState(
      state
    );

  const total =
    rows.reduce(
      (n, row) =>
        n + row.total,
      0
    );

  const inStock =
    rows.reduce(
      (n, row) =>
        n + row.inStock,
      0
    );

  log.ok(
    `${config.dataFile} (${total} products tracked, ${inStock} in-stock)`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

function printSummary(context) {
  const {
    runStart,
    isDryRun,
    initMode,
    totalSeen,
    allNew,
    allRestocked,
  } = context;

  log.blank();
  log.divider();

  const parts = [];

  if (initMode) {
    parts.push(
      'Baseline complete'
    );
  }

  else {
    parts.push(
      `${totalSeen} products checked`
    );

    if (allNew.length) {
      parts.push(
        `${allNew.length} new`
      );
    }

    if (allRestocked.length) {
      parts.push(
        `${allRestocked.length} restocked`
      );
    }

    if (
      !allNew.length &&
      !allRestocked.length
    ) {
      parts.push(
        'no changes'
      );
    }
  }

  if (isDryRun) {
    parts.push(
      'DRY RUN'
    );
  }

  parts.push(
    elapsed(runStart)
  );

  console.log(
    parts.join('  ·  ')
  );

  log.divider();
  log.blank();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function run({
  isDryRun = false,
  forceInit = false,
} = {}) {
  const runStart =
    Date.now();

  const now =
    new Date().toISOString();

  const state =
    stateMod.loadState();

  const initMode =
    forceInit ||
    isFirstRun(state);

  // Header
  log.divider();

  const modeFlags = [
    initMode
      ? 'INIT'
      : null,

    isDryRun
      ? 'DRY RUN'
      : null,
  ].filter(Boolean);

  const modeSuffix =
    modeFlags.length
      ? ` [${modeFlags.join(' · ')}]`
      : '';

  console.log(
    `Pokemon TCG Monitor · ${now}${modeSuffix}`
  );

  log.divider();

  // ───────────────────────────────────────────────────────────────────────────
  // Phase counts
  //
  // INIT:
  //   1 PC Queue
  //   2 MSRP
  //   3 Scrapers + Reddit
  //   4 Baseline
  //
  // NORMAL:
  //   1 PC Queue
  //   2 MSRP
  //   3 Scrapers + Reddit
  //   4 Compare
  //   5 Notify
  //   6 Save
  // ───────────────────────────────────────────────────────────────────────────

  const totalPhases =
    initMode
      ? 4
      : 6;

  let phase = 0;

  // ───────────────────────────────────────────────────────────────────────────
  // [1] Pokémon Center
  // ───────────────────────────────────────────────────────────────────────────

  await checkPokemonCenterQueue(
    ++phase,
    totalPhases,
    isDryRun
  );

  // ───────────────────────────────────────────────────────────────────────────
  // [2] MSRP
  // ───────────────────────────────────────────────────────────────────────────

  await refreshMsrp(
    ++phase,
    totalPhases
  );

  // ───────────────────────────────────────────────────────────────────────────
  // [3] Retailers + Reddit in parallel
  // ───────────────────────────────────────────────────────────────────────────

  const [
    scraperResults,
    redditAlerts,
  ] =
    await Promise.all([
      scrapeRetailers(
        ++phase,
        totalPhases
      ),

      scrapeRedditAlerts(
        phase,
        totalPhases
      ),
    ]);

  // ───────────────────────────────────────────────────────────────────────────
  // FIRST RUN
  // ───────────────────────────────────────────────────────────────────────────

  if (initMode) {
    await runInit(
      scraperResults,
      ++phase,
      totalPhases
    );

    printSummary({
      runStart,
      isDryRun,
      initMode: true,
      totalSeen: 0,
      allNew: [],
      allRestocked: [],
    });

    return {
      initMode: true,
      newProducts: [],
      restockedProducts: [],
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [4] Compare
  // ───────────────────────────────────────────────────────────────────────────

  const {
    allNew,
    allRestocked,
    totalSeen,
  } =
    compareRetailers(
      scraperResults,
      state,
      ++phase,
      totalPhases
    );

  // ───────────────────────────────────────────────────────────────────────────
  // Combine product + Reddit alerts
  // ───────────────────────────────────────────────────────────────────────────

  const toNotify = [
    ...allNew,
    ...allRestocked,
    ...redditAlerts,
  ];

  logFlaggedProducts(
    allNew,
    allRestocked
  );

  if (redditAlerts.length) {
    log.blank();

    for (const post of redditAlerts) {
      const subreddit =
        post.subreddit
          ? ` [r/${post.subreddit}]`
          : '';

      log.item(
        'REDDIT',
        `${post.name}${subreddit} ${
          post.url ?? ''
        }`
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [5] Notifications
  // ───────────────────────────────────────────────────────────────────────────

  await sendNotifications(
    toNotify,
    ++phase,
    totalPhases,
    isDryRun
  );

  // ───────────────────────────────────────────────────────────────────────────
  // [6] Save
  // ───────────────────────────────────────────────────────────────────────────

  persistState(
    state,
    ++phase,
    totalPhases,
    isDryRun
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Summary
  // ───────────────────────────────────────────────────────────────────────────

  printSummary({
    runStart,
    isDryRun,
    initMode: false,
    totalSeen,
    allNew,
    allRestocked,
  });

  return {
    initMode: false,
    newProducts: allNew,
    restockedProducts: allRestocked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args =
    process.argv.slice(2);

  const isDryRun =
    args.includes('--test') ||
    args.includes('-t');

  const isOnce =
    args.includes('--once') ||
    process.env.CI === 'true';

  const forceInit =
    args.includes('--init');

  if (isDryRun) {
    console.log(
      '[Monitor] Dry-run mode — scraping and comparing, but no notifications or state writes.'
    );
  }

  const runOnce = () =>
    run({
      isDryRun,
      forceInit,
    }).catch(err => {
      console.error(
        '\n[Monitor] Fatal error:',
        err.stack ??
        err.message
      );

      process.exit(1);
    });

  // ───────────────────────────────────────────────────────────────────────────
  // ONE SHOT
  // ───────────────────────────────────────────────────────────────────────────

  if (isOnce || isDryRun) {
    runOnce();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CRON MODE
  // ───────────────────────────────────────────────────────────────────────────

  else {
    const cron =
      require('node-cron');

    console.log(
      `[Monitor] Cron mode — schedule: ${
        config.checkInterval
      }`
    );

    console.log(
      '[Monitor] Starting first run immediately…\n'
    );

    runOnce().then(() => {
      cron.schedule(
        config.checkInterval,
        () =>
          run({
            isDryRun: false,
            forceInit: false,
          })
      );

      console.log(
        `[Monitor] Next run scheduled. Waiting…`
      );
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  run,
};
