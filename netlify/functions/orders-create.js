// netlify/functions/orders-create.js
const crypto = require("crypto");

const {
  SHOPIFY_WEBHOOK_SECRET,
  SHOPIFY_SHOP,
  SHOPIFY_API_VERSION = "2024-07",
  SHOPIFY_ACCESS_TOKEN
} = process.env;

const hdr = () => ({
  "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
  "Content-Type": "application/json"
});

function hmacOk(raw, sig) {
  if (!SHOPIFY_WEBHOOK_SECRET || !sig) return false;
  const calc = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(raw, "utf8").digest("base64");
  return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(sig));
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    const sig = event.headers["x-shopify-hmac-sha256"] || event.headers["X-Shopify-Hmac-Sha256"];
    const raw = event.body || "";
    if (!hmacOk(raw, sig)) return json(401, { ok: false, error: "Invalid HMAC" });

    const order = JSON.parse(raw);
    const id = Number(order?.id);
    if (!id) return json(400, { ok: false, error: "No order id" });

    // Add MO:PENDING tag (keeps existing)
    const currentTags = Array.isArray(order.tags)
      ? order.tags
      : String(order.tags || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!currentTags.includes("MO:PENDING")) currentTags.push("MO:PENDING");

    const base = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}`;
    const put = await fetch(`${base}/orders/${id}.json`, {
      method: "PUT",
      headers: hdr(),
      body: JSON.stringify({ order: { id, tags: currentTags.join(", ") } })
    });
    if (!put.ok) return json(502, { ok: false, error: `Shopify update failed (${put.status})` });

    return json(200, { ok: true });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
};

