require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { scrapeRestockd } = require('../monitors/restockd');
const { sendDiscordNotification } = require('../notifiers/discord');

const STATE_FILE = path.join(__dirname, '..', 'data', 'restockd-seen.json');

async function main() {
  const baseline = process.env.RESTOCKD_BASELINE === 'true';
  const sightings = await scrapeRestockd();

  console.log(`[Restockd PROD] ${sightings.length} unseen Sacramento-area sighting(s). baseline=${baseline}`);

  if (!baseline && sightings.length) {
    const result = await sendDiscordNotification(sightings);
    console.log(`[Restockd PROD] Discord sent=${result.sent}, failed=${result.failed}`);
    if (result.failed) process.exitCode = 1;
  } else if (baseline && sightings.length) {
    console.log('[Restockd PROD] Baseline mode: recorded current sightings without notifying Discord.');
  }

  // Workflow persists this file via cache after the run.
  if (!fs.existsSync(STATE_FILE)) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, '[]\n');
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
