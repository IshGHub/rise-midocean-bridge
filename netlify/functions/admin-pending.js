// netlify/functions/admin-pending.js
const crypto = require("crypto");

const {
  SHOPIFY_SHOP,
  SHOPIFY_API_VERSION = "2024-07",
  SHOPIFY_ACCESS_TOKEN,
  APPROVAL_SECRET,
  APPROVAL_TTL_MINUTES = "2880"
} = process.env;

const ttl = Number(APPROVAL_TTL_MINUTES) || 2880;

function html(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function sign(id, expIso) {
  const token = crypto.createHmac("sha256", APPROVAL_SECRET).update(`${id}:${expIso}`).digest("base64");
  return token.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");
}

function supplierFromOwn(ownSku) {
  const base = ownSku && ownSku.endsWith("-MID") ? ownSku.slice(0, -4) : ownSku || "";
  return base.split("").reverse().join("");
}

exports.handler = async () => {
  if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
    return html(500, "<p>Missing Shopify env</p>");
  }
  if (!APPROVAL_SECRET) return html(500, "<p>Missing APPROVAL_SECRET</p>");

  const base = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}`;
  const res = await fetch(`${base}/orders.json?status=any&financial_status=any&fulfillment_status=any&limit=100&order=created_at%20desc`, {
    headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN }
  });
  if (!res.ok) return html(502, `<p>Shopify read failed (${res.status})</p>`);
  const orders = (await res.json())?.orders || [];

  const pendings = orders.filter(o => {
    const tags = Array.isArray(o.tags) ? o.tags : String(o.tags || "").split(",").map(s=>s.trim());
    return tags.includes("MO:PENDING");
  });

  const now = Date.now();
  const ex = new Date(now + ttl * 60_000).toISOString().replace(/\.\d+Z$/,"Z");

  const rows = pendings.map(o => {
    const token = sign(o.id, ex);
    const items = (o.line_items || []).map(li =>
      `${esc(li.title)} — <b>${esc(li.sku || "")}</b> (${esc(supplierFromOwn(li.sku || ""))}) × ${li.quantity}`
    ).join("<br>");
    // POST forms to match endpoints expecting POST
    return `<tr>
      <td>${esc(o.name)}</td>
      <td>${esc(o.created_at)}</td>
      <td>${esc(o.email || "")}</td>
      <td>${items || "-"}</td>
      <td style="white-space:nowrap;">
        <form method="POST" action="/.netlify/functions/admin-approve" style="display:inline;">
          <input type="hidden" name="id" value="${o.id}">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="expires" value="${esc(ex)}">
          <button>Approve</button>
        </form>
        <form method="POST" action="/.netlify/functions/admin-reject" style="display:inline;margin-left:6px;">
          <input type="hidden" name="id" value="${o.id}">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="expires" value="${esc(ex)}">
          <button>Reject</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  const page = `
  <html><head><meta charset="utf-8"><title>Pending review</title></head>
  <body style="font-family:Arial,sans-serif">
    <h2>Pending review orders</h2>
    <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse">
      <thead><tr><th>Order</th><th>Created</th><th>Email</th><th>Items (Own SKU → Supplier)</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No pending orders.</td></tr>'}</tbody>
    </table>
  </body></html>`;

  return html(200, page);
};

