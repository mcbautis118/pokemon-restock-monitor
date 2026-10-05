require('dotenv').config();

const keywords = (process.env.SEARCH_KEYWORDS || 'pokemon trading card game,pokemon tcg booster,pokemon elite trainer box')
  .split(',').map(k => k.trim()).filter(Boolean);

const filterKeywords = (process.env.FILTER_KEYWORDS || 'booster,elite trainer,etb,tin,collection,bundle,box,pack')
  .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

module.exports = {
  notify: {
    channels: (process.env.NOTIFY_CHANNELS || 'discord,email')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  },

  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    communityWebhookUrl: process.env.DISCORD_COMMUNITY_WEBHOOK_URL || '',
    mention: process.env.DISCORD_MENTION || '',
  },

  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    from: process.env.EMAIL_FROM || '',
    to: process.env.EMAIL_TO || '',
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
      },
    },
  },

  retailers: {
    target: {
      enabled: process.env.TARGET_ENABLED !== 'true',
      name: 'Target',
      color: 0xcc0000,
      keywords,
    },
    walmart: {
      enabled: process.env.WALMART_ENABLED !== 'true',
      name: 'Walmart',
      color: 0x0071ce,
      keywords,
    },
    bestbuy: {
      enabled: false,
      name: 'Best Buy',
      color: 0xffe000,
      apiKey: process.env.BESTBUY_API_KEY || '',
      keywords,
    },
    amazon: {
      enabled: process.env.AMAZON_ENABLED !== 'false',
      name: 'Amazon',
      color: 0xff9900,
      accessKey: process.env.AMAZON_ACCESS_KEY || '',
      secretKey: process.env.AMAZON_SECRET_KEY || '',
      partnerTag: process.env.AMAZON_PARTNER_TAG || '',
      fbaOnly: process.env.AMAZON_FBA_ONLY === 'true',
    },
    gamestop: {
      enabled: process.env.GAMESTOP_ENABLED === 'true',
      name: 'GameStop',
      color: 0xe31837,
      keywords,
    },
    barnesandnoble: {
      enabled: process.env.BN_ENABLED !== 'false',
      name: 'Barnes & Noble',
      color: 0x1d6b3d,
      keywords,
    },
    costco: {
      // Disabled until the customer-facing warehouse endpoint is live-tested
      // from the intended runtime. No Costco login/API secret is required by
      // this prototype.
      enabled: process.env.COSTCO_ENABLED === 'true',
      name: 'Costco',
      color: 0x005dab,
      itemNumbers: (process.env.COSTCO_ITEM_NUMBERS || '')
        .split(',').map(s => s.trim()).filter(Boolean),
      warehouses: [
        { number: '438', name: 'Rancho Cordova' },
        { number: '464', name: 'Sacramento' },
        { number: '765', name: 'Folsom' },
        { number: '771', name: 'Citrus Heights' },
      ],
    },
    pokemoncenter: {
      enabled: process.env.PC_ENABLED !== 'true',
      name: 'Pokemon Center',
      color: 0xff0000,
      cookie: process.env.PC_COOKIE || '',
      watchUrls: (process.env.PC_WATCH_URLS || '').split(',').map(u => u.trim()).filter(Boolean),
      queueitIds: (process.env.PC_QUEUEIT_IDS || 'pokemoncenter,pokemon,tpci').split(',').map(s => s.trim()).filter(Boolean),
      mentionEveryone: process.env.PC_QUEUE_MENTION_EVERYONE === 'true',
    },
  },

  reddit: {
    enabled: process.env.REDDIT_ENABLED !== 'false',
    subreddits: (process.env.REDDIT_SUBREDDITS || 'PokemonTCG,PokeInvesting')
      .split(',').map(s => s.trim()).filter(Boolean),
  },

  discordListener: {
    enabled: process.env.LISTENER_ENABLED === 'true',
    port: parseInt(process.env.LISTENER_PORT || '3001', 10),
    secret: process.env.LISTENER_SECRET || '',
  },

  filterKeywords,
  maxPages: parseInt(process.env.MAX_PAGES || '3', 10),
  dataFile: './data/products.json',
  checkInterval: '*/15 * * * *',

  requestHeaders: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
  },
};
