// netlify/functions/admin-approve.js
const crypto = require("crypto");

const {
  APPROVAL_SECRET,
  SHOPIFY_SHOP,
  SHOPIFY_API_VERSION = "2024-07",
  SHOPIFY_ACCESS_TOKEN,
  MIDOCEAN_BASE_URL = "https://api.midocean.com",
  MIDOCEAN_API_KEY
} = process.env;

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

function supplierFromOwn(ownSku) {
  const base = ownSku && ownSku.endsWith("-MID") ? ownSku.slice(0, -4) : ownSku || "";
  return base.split("").reverse().join("");
}

function verify(id, exp, token) {
  if (!APPROVAL_SECRET) return false;
  if (!id || !exp || !token) return false;
  if (new Date(exp).getTime() < Date.now()) return false;
  const msg = `${id}:${exp}`;
  const expected = crypto.createHmac("sha256", APPROVAL_SECRET).update(msg).digest("base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

function parseParams(event) {
  const url = new URL(event.rawUrl || `${event.headers["x-forwarded-proto"]||"https"}://${event.headers.host}${event.path}${event.rawQuery ? "?"+event.rawQuery : ""}`);
  const q = Object.fromEntries(url.searchParams.entries());
  if (event.httpMethod === "POST" && event.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
    const p = Object.fromEntries(new URLSearchParams(event.body || "").entries());
    return { ...q, ...p };
  }
  if (event.httpMethod === "POST" && event.headers["content-type"]?.includes("application/json")) {
    try { return { ...q, ...JSON.parse(event.body || "{}") }; } catch { return q; }
  }
  return q;
}

exports.handler = async (event) => {
  try {
    const params = parseParams(event);
    const id = Number(params.id || "");
    const token = params.token || "";
    const expires = params.expires || "";
    if (!verify(id, expires, token)) return html(401, "<p>Invalid or expired token</p>");

    // Read order
    const base = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}`;
    const hdr = { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" };
    const getRes = await fetch(`${base}/orders/${id}.json`, { headers: hdr });
    if (!getRes.ok) return html(502, `<p>Shopify read failed (${getRes.status})</p>`);
    const order = (await getRes.json())?.order;
    if (!order?.id) return html(404, "<p>Order not found</p>");

    // Build Midocean payload
    const lines = (order.line_items || []).map((li, idx) => {
      const props = new Map((li.properties || []).map(p => [p.name, String(p.value)]));
      const isPrint = props.get("mo_print") === "true";
      if (isPrint) {
        return {
          order_line_id: String(10 + idx),
          master_code: props.get("mo_master_code") || (li.sku || "").split("-")[0],
          quantity: String(li.quantity || 1),
          expected_price: "0",
          printing_positions: [{
            id: props.get("mo_position_id") || "FRONT",
            print_size_height: props.get("mo_print_h") || "20",
            print_size_width:  props.get("mo_print_w") || "50",
            printing_technique_id: props.get("mo_technique_id") || "S2",
            number_of_print_colors: props.get("mo_colors") || "1",
            print_artwork_url: props.get("mo_artwork_url") || "",
            print_mockup_url: props.get("mo_mockup_url") || "",
            print_instruction: props.get("mo_instruction") || ""
          }],
          print_items: [{ item_color_number: props.get("mo_item_color_number") || "", quantity: String(li.quantity || 1) }]
        };
      }
      return {
        order_line_id: String(1 + idx),
        sku: supplierFromOwn(li.sku || ""),
        quantity: String(li.quantity || 1),
        expected_price: "0"
      };
    });

    const payload = {
      order_header: {
        po_number: String(order.order_number || order.name || ""),
        contact_email: order.email || "",
        currency: order.currency || "EUR",
        timestamp: new Date().toISOString().replace(/\.\d+Z$/,""),
        order_type: lines.some(l => l.printing_positions) ? "PRINT" : "NORMAL",
        shipping_address: {
          contact_name: order.shipping_address?.name || "",
          company_name: order.shipping_address?.company || "",
          street1: `${order.shipping_address?.address1 || ""} ${order.shipping_address?.address2 || ""}`.trim(),
          postal_code: order.shipping_address?.zip || "",
          city: order.shipping_address?.city || "",
          region: order.shipping_address?.province || "",
          country: order.shipping_address?.country_code || "",
          email: order.email || "",
          phone: order.shipping_address?.phone || ""
        }
      },
      order_lines: lines
    };

    // Send to Midocean
    const moRes = await fetch(`${MIDOCEAN_BASE_URL}/gateway/order/2.1/create`, {
      method: "POST",
      headers: { "x-Gateway-APIKey": MIDOCEAN_API_KEY, "Accept": "text/json", "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!moRes.ok) {
      const errTxt = await moRes.text();
      return html(502, `<h3>${esc(order.name)}</h3><p>Midocean rejected.</p><pre>${esc(errTxt)}</pre>`);
    }
    const moData = await moRes.json();
    const moNumber = String(moData?.order_number || moData?.number || "");

    // Update Shopify tags (MO:SENT) and note_attributes
    const currentTags = String(order.tags || "").split(",").map(s=>s.trim()).filter(Boolean);
    const tags = currentTags.filter(t => t !== "MO:PENDING");
    if (!tags.includes("MO:SENT")) tags.push("MO:SENT");

    await fetch(`${base}/orders/${id}.json`, {
      method: "PUT",
      headers: hdr,
      body: JSON.stringify({ order: {
        id,
        tags: tags.join(", "),
        note_attributes: [{ name: "midocean_order_number", value: moNumber }]
      }})
    });

    return html(200, `<html><body style="font-family:Arial,sans-serif"><h3>${esc(order.name)}</h3><p>Sent to Midocean. Ref: <b>${esc(moNumber)}</b></p></body></html>`);
  } catch (e) {
    return html(500, `<p>Unexpected error: ${esc(e?.message || String(e))}</p>`);
  }
};

