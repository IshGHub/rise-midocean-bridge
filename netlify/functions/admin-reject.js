// netlify/functions/admin-reject.js
import crypto from "node:crypto";

const {
  APPROVAL_SECRET,
  SHOPIFY_SHOP,
  SHOPIFY_API_VERSION = "2024-07",
  SHOPIFY_ACCESS_TOKEN
} = process.env;

function bad(msg, code = 400) {
  return new Response(`<html><body style="font-family:Arial,sans-serif"><h3>Reject</h3><p>${escapeHtml(msg)}</p></body></html>`, {
    status: code,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function ok(msg) {
  return new Response(`<html><body style="font-family:Arial,sans-serif"><h3>Reject</h3><p>${escapeHtml(msg)}</p></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function sign(orderId, expiresIso) {
  const msg = `${orderId}:${expiresIso}`;
  const digest = crypto.createHmac("sha256", APPROVAL_SECRET).update(msg).digest("base64");
  return digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");
}

function isExpired(expiresIso) {
  return new Date(expiresIso).getTime() < Date.now();
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return bad("Method not allowed", 405);
    if (!APPROVAL_SECRET) return bad("Missing APPROVAL_SECRET env", 500);
    if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) return bad("Missing Shopify env", 500);

    const url = new URL(event.rawUrl || `${event.headers["x-forwarded-proto"]||"https"}://${event.headers.host}${event.path}${event.rawQuery ? "?"+event.rawQuery : ""}`);
    const id = Number(url.searchParams.get("id") || "");
    const token = url.searchParams.get("token") || "";
    const expires = url.searchParams.get("expires") || "";

    if (!id || !token || !expires) return bad("Missing id/token/expires", 400);
    if (isExpired(expires)) return bad("Link expired", 401);

    const expected = sign(id, expires);
    if (expected !== token) return bad("Invalid token", 401);

    // Fetch current order to preserve existing tags
    const base = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}`;
    const hdr = { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" };

    const getRes = await fetch(`${base}/orders/${id}.json`, { headers: hdr });
    if (!getRes.ok) return bad(`Shopify read failed (${getRes.status})`, 502);
    const order = (await getRes.json())?.order;
    if (!order?.id) return bad("Order not found", 404);

    const currentTags = Array.isArray(order.tags) ? order.tags : String(order.tags || "").split(",").map(s=>s.trim()).filter(Boolean);
    if (!currentTags.includes("MO:REJECTED")) currentTags.push("MO:REJECTED");

    const putRes = await fetch(`${base}/orders/${id}.json`, {
      method: "PUT",
      headers: hdr,
      body: JSON.stringify({ order: { id, tags: currentTags.join(", ") } })
    });
    if (!putRes.ok) return bad(`Shopify update failed (${putRes.status})`, 502);

    return ok(`Order ${escapeHtml(order.name || "#"+id)} marked as REJECTED. Nothing sent to Midocean.`);
  } catch (e) {
    return bad(`Unexpected error: ${escapeHtml(e?.message || String(e))}`, 500);
  }
}

