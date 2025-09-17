// File: netlify/functions/orders-create.js
const { json, error, verifyShopifyWebhook, env } = require("./_lib/common");

module.exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") return json(200, { ok: true, method: "GET" });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method Not Allowed" });

    const qs = event.queryStringParameters || {};
    const { APPROVAL_SECRET } = env();

    // DEV BYPASS: accept & log any POST if ?dev=1&secret=<APPROVAL_SECRET>
    if (qs.dev === "1" && qs.secret === APPROVAL_SECRET) {
      console.log("orders-create DEV BYPASS", { headers: event.headers });
      return json(200, { ok: true, dev_bypass: true });
    }

    const hmac =
      event.headers["x-shopify-hmac-sha256"] ||
      event.headers["X-Shopify-Hmac-Sha256"] ||
      event.headers["x-shopify-hmac-sha256".toLowerCase()];
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : Buffer.from(event.body || "", "utf8");

    const ok = verifyShopifyWebhook({ bodyRaw: rawBody, hmacHeader: hmac });
    if (!ok) {
      console.log("orders-create HMAC invalid", { hasHmac: !!hmac, len: rawBody.length });
      return error(401, "HMAC invalid");
    }

    console.log("orders-create OK", { len: rawBody.length });
    return json(200, { ok: true });
  } catch (e) {
    console.log("orders-create ERROR", e.message);
    return error(500, e.message);
  }
};
