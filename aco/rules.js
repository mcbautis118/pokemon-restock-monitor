'use strict';

// Private ACO foundation. This module never makes purchases.
const RETAILER_AUTH = Object.freeze({
  target: false,
  bestbuy: false,
  walmart: false,
  pokemoncenter: false
});

function evaluateCandidate(candidate, rules) {
  if (!candidate || !rules) throw new Error('Candidate and rules are required');
  const reasons = [];
  const retailer = String(candidate.retailer || '').toLowerCase();
  const price = Number(candidate.price);
  const quantity = Number(candidate.quantity ?? 1);
  const maxPrice = Number(rules.maxUnitPrice);
  const maxQuantity = Number(rules.maxQuantity);
  if (!rules.enabled) reasons.push('Rules disabled');
  if (!Array.isArray(rules.productIds) || !rules.productIds.includes(candidate.productId))
    reasons.push('Product not approved');
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(maxPrice) || price > maxPrice)
    reasons.push('Price invalid or above limit');
  if (!Number.isInteger(quantity) || quantity < 1 || !Number.isInteger(maxQuantity) || quantity > maxQuantity)
    reasons.push('Quantity invalid or above limit');
  if (candidate.inStock !== true) reasons.push('Stock not confirmed');
  if (RETAILER_AUTH[retailer] !== true) reasons.push('Automated checkout not authorized for retailer');
  return { eligible: reasons.length === 0, reasons, mode: 'dry_run', retailer,
    productId: candidate.productId, price, quantity };
}

module.exports = { evaluateCandidate, RETAILER_AUTH };
