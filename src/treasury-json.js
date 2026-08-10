// Treasury exposes several identifiers and feed cursors as JSON int64 values.
// JavaScript JSON.parse rounds values above 2^53, so quote known int64 fields
// before parsing and keep them as exact decimal strings internally.
const INT64_FIELD = /("(?:id|accountId|postingId|txnId|subscriptionId|deliveryId|keyId|firmId|cursor|nextCursor)"\s*:\s*)(-?\d+)(?=\s*[,}])/g;

export function parseTreasuryJson(text) {
  if (!text || !String(text).trim()) return {};
  return JSON.parse(String(text).replace(INT64_FIELD, "$1\"$2\""));
}
