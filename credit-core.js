// Business limits shared by the member and administrator endpoints.
export const MAX_ORDER_POINTS = 100000;
export const MAX_WALLET_POINTS = 10000000;
export function parseRequestedPoints(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_ORDER_POINTS ? value : null;
}
export function validOrderId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function cleanRemark(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length <= 200 && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}
