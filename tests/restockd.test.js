const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAllSightings,
  cleanProductName,
  parseAge,
  parseStatus,
  freshnessForAge,
  MAX_ALERT_AGE_MINUTES,
} = require('../monitors/restockd');

const TARGET = 'https://restockd.app/pokemon-in-store?retailer=target';

function tableRow(product, location, status, age) {
  return `<table><tbody><tr><td>${product}</td><td>${location}</td><td>${status}</td><td>${age}</td></tr></tbody></table>`;
}

test('cleans Restockd product labels', () => {
  assert.equal(cleanProductName('30th Celebration Elite Trainer BoxPokémon'), '30th Celebration Elite Trainer Box');
  assert.equal(
    cleanProductName('Reported near storePitch Black Sleeved Booster PackPokémon · posted from the store'),
    'Pitch Black Sleeved Booster Pack'
  );
});

test('parses minute, hour and day ages', () => {
  assert.deepEqual(parseAge('8m ago'), { ageText: '8m ago', ageMinutes: 8 });
  assert.deepEqual(parseAge('1h ago'), { ageText: '1h ago', ageMinutes: 60 });
  assert.deepEqual(parseAge('3d ago'), { ageText: '3d ago', ageMinutes: 4320 });
});

test('grades freshness', () => {
  assert.equal(freshnessForAge(8).freshness, 'VERY FRESH');
  assert.equal(freshnessForAge(25).freshness, 'FRESH');
  assert.equal(freshnessForAge(45).freshness, 'RECENT');
  assert.equal(freshnessForAge(120).freshness, 'OLDER REPORT');
  assert.equal(freshnessForAge(MAX_ALERT_AGE_MINUTES + 1).freshness, 'STALE');
});

test('distinguishes mixed status from sold out', () => {
  const mixed = parseStatus('In stock1 sold out');
  assert.equal(mixed.stockStatus, 'mixed');
  assert.equal(mixed.alertable, true);

  const soldOut = parseStatus('Sold out');
  assert.equal(soldOut.stockStatus, 'out_of_stock');
  assert.equal(soldOut.alertable, false);
});

test('parses a fresh local in-stock row into actionable fields', () => {
  const [sighting] = extractAllSightings(
    tableRow('30th Celebration Elite Trainer BoxPokémon', 'FolsomFolsom, CA', 'In stock', '8m ago'),
    TARGET
  );

  assert.equal(sighting.name, '30th Celebration Elite Trainer Box');
  assert.equal(sighting.location, 'FolsomFolsom, CA');
  assert.equal(sighting.stockStatus, 'reported');
  assert.equal(sighting.ageMinutes, 8);
  assert.equal(sighting.freshness, 'VERY FRESH');
  assert.equal(sighting.alertable, true);
});

test('keeps mixed reports alertable but labels them accurately', () => {
  const [sighting] = extractAllSightings(
    tableRow('30th Celebration Mini TinsPokémon', 'FolsomFolsom, CA', 'In stock1 sold out', '14m ago'),
    TARGET
  );

  assert.equal(sighting.stockStatus, 'mixed');
  assert.match(sighting.statusLabel, /Mixed reports/);
  assert.equal(sighting.alertable, true);
});

test('suppresses closed and stale reports', () => {
  const [closed] = extractAllSightings(
    tableRow('30th Celebration Mini TinsPokémon', 'FolsomFolsom, CA', 'Closed', '37m ago'),
    TARGET
  );
  assert.equal(closed.alertable, false);

  const [stale] = extractAllSightings(
    tableRow('Pitch Black Booster BundlePokémon', 'FolsomFolsom, CA', 'In stock', '4h ago'),
    TARGET
  );
  assert.equal(stale.ageMinutes, 240);
  assert.equal(stale.freshness, 'STALE');
  assert.equal(stale.alertable, false);
});
