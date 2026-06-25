/**
 * Dunable Guitars — Airtable → Shopify DE Product Sync
 * Syncs records from the "Dunable DE" Airtable table where
 * "Sync to Shopify DE" checkbox is checked.
 * Adds each product to the correct model collection automatically.
 * Called by sync-app-de.html via a local Express server.
 */

require("dotenv").config();
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));
const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────

const SHOPIFY_STORE         = process.env.SHOPIFY_STORE_DE         || "dunable-de.myshopify.com";
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID_DE;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET_DE;
const AIRTABLE_API_KEY      = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID     = "appsNlpsnFyoPnQBG";
const AIRTABLE_TABLE_ID    = "tbllGzeQdwoE07GWG";

// DE model names → Shopify collection titles
// These should match exactly how your collections are named in Shopify
const MODEL_TO_COLLECTION = {
  "Yeti DE":          "Yeti DE",
  "Gnarwhal DE":      "Gnarwhal DE",
  "Minotaur DE":      "Minotaur DE",
  "Cyclops DE":       "Cyclops DE",
  "R2 DE":            "R2 DE",
  "Asteroid DE":      "Asteroid DE",
  "Gnarwhal DE Bass": "Gnarwhal DE Bass",
  "R2 DE Bass":       "R2 DE Bass",
};

const DEFAULT_VENDOR       = "Dunable Guitars";
const DEFAULT_PRODUCT_TYPE = "Electric Guitar";

const PORT = process.env.PORT || 3001; // Railway injects PORT automatically

// ─── SHOPIFY AUTH (direct Admin API token) ────────────────────────────────
// Token is stored in .env as SHOPIFY_ACCESS_TOKEN_DE.
// To get one: Shopify Admin → Settings → Apps and sales channels → Develop apps
// → Create app → configure scopes → Install → reveal Admin API access token.

async function getShopifyToken() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN_DE;
  if (token) return token;
  throw new Error(
    "SHOPIFY_ACCESS_TOKEN_DE is missing from your .env file.\n" +
    "Visit http://localhost:3001/setup for instructions on getting the token."
  );
}

// ─── SHOPIFY HELPERS ───────────────────────────────────────────────────────

async function shopifyHeaders() {
  const token = await getShopifyToken();
  return {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": token,
  };
}

async function shopifyGet(endpoint) {
  const response = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-01/${endpoint}`,
    { headers: await shopifyHeaders() }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Shopify GET ${endpoint} failed (${response.status}): ${err}`);
  }
  return response.json();
}

async function shopifyPost(endpoint, body) {
  const response = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-01/${endpoint}`,
    {
      method: "POST",
      headers: await shopifyHeaders(),
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Shopify POST ${endpoint} failed (${response.status}): ${err}`);
  }
  return response.json();
}

async function shopifyPut(endpoint, body) {
  const response = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-01/${endpoint}`,
    {
      method: "PUT",
      headers: await shopifyHeaders(),
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Shopify PUT ${endpoint} failed (${response.status}): ${err}`);
  }
  return response.json();
}

// ─── AIRTABLE ──────────────────────────────────────────────────────────────

async function fetchAirtableRecords() {
  if (!AIRTABLE_API_KEY) {
    throw new Error(
      "Missing AIRTABLE_API_KEY in your .env file.\n" +
      "Get one at: https://airtable.com/create/tokens"
    );
  }

  const records = [];
  let offset = null;

  do {
    const url = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`
    );
    url.searchParams.set("pageSize", "100");
    // Filter to only records with "Sync to Shopify DE" checked
    url.searchParams.set("filterByFormula", "{Sync to Shopify DE}=1");
    if (offset) url.searchParams.set("offset", offset);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Airtable fetch failed (${response.status}): ${err}`);
    }
    const data = await response.json();
    records.push(...data.records);
    offset = data.offset || null;
  } while (offset);

  return records;
}

// ─── FIELD MAPPING ─────────────────────────────────────────────────────────

function buildProductDescription(fields) {
  // Build spec table from DE fields — ordered per brand spec sheet
  const specs = [
    ["Model",            fields["Model Name"] || fields["Model Title"]],
    ["Model Variant",    fields["Model Variant"]],
    ["Orientation",      fields["Orientation"]],
    ["Strings",          fields["Strings"]],
    ["Scale Length",     fields["Scale Length"]],
    ["Body Wood",        fields["Body Wood"]],
    ["Body Top Wood",    typeof fields["Body Top Wood"] === "string" ? fields["Body Top Wood"] : (typeof fields["Body Top"] === "string" ? fields["Body Top"] : null)],
    ["Neck Wood",        fields["Neck Wood"]],
    ["Fingerboard Wood", fields["Fingerboard Wood"] || fields["Fingerboard"]],
    ["Binding",          fields["Binding"]],
    ["Inlay",            fields["Inlay"]],
    ["Side Dots",        fields["Side Dots"]],
    ["Frets",            fields["Frets"] || fields["Fret Wire"] || fields["frets"] || fields["# of Frets"] || fields["Number of Frets"]],
    ["Nut",              fields["Nut"] || fields["Nut1"]],
    ["Hardware Color",   fields["Hardware Color"]],
    ["Tuners",           fields["Tuners"]],
    ["Bridge",           fields["Bridge"] || fields["Bridge1"]],
    ["Tailpiece",        fields["Tailpiece"]],
    ["Pickguard",        fields["Pickguard"]],
    ["Finish Color",     fields["Finish Color"]],
    ["Finish Type",      fields["Finish Type"]],
    ["Neck Pickup",      fields["Neck Pickup"] || fields["Neck pickup"]],
    ["Bridge Pickup",    fields["Bridge Pickup"] || fields["Bridge pickup"]],
    ["Volume Control",   fields["Volume control"] || fields["Volume Control"] || fields["volume control"]],
    ["Tone Control",     fields["Tone Control"] || fields["Tone control"] || fields["tone control"]],
    ["Other Controls",   fields["Other Controls"] || fields["other controls"] || fields["Controls"] || fields["vol/tone controls"]],
    ["Setup/Strings",    fields["Setup/Strings"] || fields["Setup"]],
    ["Case",             (typeof fields["case"] === "string" ? fields["case"] : null) || (typeof fields["Case"] === "string" ? fields["Case"] : null) || (typeof fields["cases"] === "string" ? fields["cases"] : null) || (typeof fields["Gig Bag / Case"] === "string" ? fields["Gig Bag / Case"] : null)],
  ].filter(([_, val]) => val);

  const rows = specs
    .map(([label, val]) => `<tr><td><strong>${label}</strong></td><td>${val}</td></tr>`)
    .join("\n");

  return `<table>${rows}</table>`;
}

function buildTags(fields) {
  const model = fields["Model"] || "";          // e.g. "Cyclops DE" → "cyclops-de" (used by smart collections)
  const finishColor = fields["Finish Color"] || "";
  const tags = ["de", "dunable-de"];
  if (model) tags.push(model.toLowerCase().replace(/\s+/g, "-"));
  if (finishColor) tags.push(finishColor.toLowerCase().replace(/\s+/g, "-"));
  return tags.join(", ");
}

function airtableRecordToShopifyProduct(record) {
  const f = record.fields;

  // Title: "Model Name — Finish Color"
  const modelName   = f["Model Name"] || f["Model Title"] || "";
  const finishColor = f["Finish Color"] || "";
  const title = [modelName, finishColor].filter(Boolean).join(" — ") || record.id;

  // SKU: UPC field
  const sku = String(f["UPC"] || f["upc"] || "").trim();

  // Price: MAP field — Airtable field name has a trailing space: "MAP "
  const mapVal = f["MAP "] != null ? f["MAP "] : (f["MAP"] != null ? f["MAP"] : (f["MAP Price"] != null ? f["MAP Price"] : null));
  const price = mapVal != null ? String(mapVal) : "0.00";

  // Images: "color reference photo copy" attachment field
  const photoField = f["color reference photo copy"] || f["color reference photo"] || [];
  const images = photoField.map((att) => ({
    src: att.url,
    alt: title,
  }));

  return {
    product: {
      title,
      body_html: buildProductDescription(f),
      vendor: DEFAULT_VENDOR,
      product_type: DEFAULT_PRODUCT_TYPE,
      tags: buildTags(f),
      status: "draft",
      published_scope: "global",
      variants: [
        {
          price,
          sku,
          inventory_management: "shopify",
          inventory_quantity: Number(f["qty ordered"] || 0),
          weight: 23,
          weight_unit: "lb",
        },
      ],
      images,
    },
  };
}

// ─── COLLECTION LOOKUP ─────────────────────────────────────────────────────

const collectionIdCache = {};

async function getCollectionId(collectionTitle) {
  if (collectionIdCache[collectionTitle]) return collectionIdCache[collectionTitle];

  // Search custom collections
  const data = await shopifyGet(
    `custom_collections.json?title=${encodeURIComponent(collectionTitle)}&limit=5`
  );
  if (data.custom_collections && data.custom_collections.length > 0) {
    collectionIdCache[collectionTitle] = data.custom_collections[0].id;
    return collectionIdCache[collectionTitle];
  }

  // Also check smart collections (just in case)
  const smartData = await shopifyGet(
    `smart_collections.json?title=${encodeURIComponent(collectionTitle)}&limit=5`
  );
  if (smartData.smart_collections && smartData.smart_collections.length > 0) {
    collectionIdCache[collectionTitle] = smartData.smart_collections[0].id;
    return collectionIdCache[collectionTitle];
  }

  return null;
}

async function addProductToCollection(productId, modelName) {
  // Map model name → collection title
  const collectionTitle =
    MODEL_TO_COLLECTION[modelName] ||
    modelName; // fall back to the model name itself

  const collectionId = await getCollectionId(collectionTitle);
  if (!collectionId) {
    console.warn(`  ⚠️  No collection found for "${collectionTitle}" — product not added to collection.`);
    return `⚠️ No collection found for "${collectionTitle}"`;
  }

  try {
    await shopifyPost("collects.json", {
      collect: { product_id: productId, collection_id: collectionId },
    });
    return `→ ${collectionTitle}`;
  } catch (err) {
    // 422 = already in this collection — fine
    if (err.message.includes("422")) return `→ ${collectionTitle} (already assigned)`;
    // 403 = smart collection — Shopify manages membership automatically via rules
    if (err.message.includes("403")) return `→ ${collectionTitle} (smart collection, auto-managed)`;
    throw err;
  }
}

// ─── EXISTING PRODUCT LOOKUP (SKU → productId + variantId + inventoryItemId) ─

async function fetchExistingProducts() {
  // Returns Map<sku, { productId, variantId, inventoryItemId }>
  const skuMap = new Map();
  let url = `https://${SHOPIFY_STORE}/admin/api/2026-01/products.json?fields=id,variants&limit=250`;

  while (url) {
    const response = await fetch(url, { headers: await shopifyHeaders() });
    if (!response.ok) break;
    const data = await response.json();
    if (!data.products) break;
    for (const p of data.products) {
      for (const v of p.variants || []) {
        if (v.sku) skuMap.set(v.sku.trim(), {
          productId: p.id,
          variantId: v.id,
          inventoryItemId: v.inventory_item_id,
        });
      }
    }
    const linkHeader = response.headers.get("link");
    const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  console.log(`Found ${skuMap.size} existing products in Shopify DE.`);
  return skuMap;
}

// ─── SET COUNTRY OF ORIGIN + HS CODE VIA INVENTORY ITEM ───────────────────
// Shopify stores these on the InventoryItem, NOT the Variant.
// Must use inventory_items/{id}.json endpoint.

async function setOriginAndHsCode(inventoryItemId) {
  if (!inventoryItemId) return;
  await shopifyPut(`inventory_items/${inventoryItemId}.json`, {
    inventory_item: {
      id: inventoryItemId,
      country_code_of_origin: "KR",
      harmonized_system_code: "920710",
    },
  });
}

// ─── SYNC LOGIC ────────────────────────────────────────────────────────────

let syncInProgress = false;

async function runSync(onProgress) {
  if (syncInProgress) {
    onProgress({ type: "error", message: "⚠️ A sync is already in progress. Please wait." });
    onProgress({ type: "done", message: "Sync blocked — already running.", created: 0, failed: 0 });
    return;
  }
  syncInProgress = true;
  try {
    await doSync(onProgress);
  } finally {
    syncInProgress = false;
  }
}

async function doSync(onProgress) {
  onProgress({ type: "log", message: "📋 Fetching records from Airtable (Sync to Shopify DE = checked)..." });
  const records = await fetchAirtableRecords();

  onProgress({ type: "log", message: `🔬 Airtable returned ${records.length} raw records matching the checkbox filter.` });

  // Debug: dump first record so we can verify field name mapping
  if (records.length > 0) {
    const f = records[0].fields;
    onProgress({ type: "log", message: `📋 First record dump: ${JSON.stringify(f, null, 0).substring(0, 1200)}` });
  }

  // Filter: must have UPC
  const syncable = records.filter((r) => {
    const f = r.fields;
    return f["UPC"] != null && String(f["UPC"]).trim() !== "";
  });

  onProgress({ type: "log", message: `📦 Found ${syncable.length} records ready to sync...` });

  if (syncable.length === 0) {
    onProgress({
      type: "done",
      message: records.length === 0
        ? "Airtable returned 0 records — check that the 'Sync to Shopify DE' field name matches exactly (case-sensitive)."
        : "Records found but none have a UPC filled in — check field names in the log above.",
      created: 0,
      failed: 0,
    });
    return;
  }

  onProgress({ type: "log", message: "🔍 Loading existing Shopify DE products for update-or-create..." });
  const existingProducts = await fetchExistingProducts();

  let created = 0, updated = 0, failed = 0;

  for (const record of syncable) {
    const f = record.fields;
    const modelName   = f["Model Name"] || f["Model Title"] || "";
    const modelShort  = f["Model"] || "";   // e.g. "Cyclops DE" — used for collection lookup
    const finishColor = f["Finish Color"] || "";
    const title = [modelName, finishColor].filter(Boolean).join(" — ") || record.id;
    const sku = String(f["UPC"] || f["upc"] || "").trim();

    // Price: "MAP " has a trailing space in Airtable — use trimmed dynamic lookup as safety net
    const mapRaw = f["MAP "] != null ? f["MAP "] : (f["MAP"] != null ? f["MAP"] : (() => {
      const k = Object.keys(f).find(key => key.trim().toUpperCase() === "MAP");
      return k != null ? f[k] : null;
    })());
    const price = mapRaw != null ? String(mapRaw) : "0.00";

    try {
      if (sku && existingProducts.has(sku)) {
        // ── UPDATE existing product ─────────────────────────────────────
        const { productId, variantId, inventoryItemId } = existingProducts.get(sku);

        // Update title, description, and tags (tags trigger smart collection membership)
        await shopifyPut(`products/${productId}.json`, {
          product: {
            id: productId,
            title,
            body_html: buildProductDescription(f),
            tags: buildTags(f),
          },
        });

        // Update price on the variant
        await shopifyPut(`variants/${variantId}.json`, {
          variant: {
            id: variantId,
            price,
          },
        });

        // Set country of origin + HS code on the InventoryItem (correct endpoint)
        await setOriginAndHsCode(inventoryItemId);

        updated++;
        onProgress({ type: "success", message: `🔄 Updated: "${title}" — price $${price}, KR, HS 920710, tags: ${buildTags(f)}` });

      } else {
        // ── CREATE new product ──────────────────────────────────────────
        const payload = airtableRecordToShopifyProduct(record);
        const data = await shopifyPost("products.json", payload);
        const product = data.product;

        // Get inventory_item_id from the created variant
        const variant = product.variants && product.variants[0];
        const variantId = variant && variant.id;
        const inventoryItemId = variant && variant.inventory_item_id;

        // Set price on variant (sometimes creation doesn't take)
        if (variantId) {
          await shopifyPut(`variants/${variantId}.json`, {
            variant: { id: variantId, price },
          });
        }

        // Set country of origin + HS code on the InventoryItem (correct endpoint)
        await setOriginAndHsCode(inventoryItemId);

        // Add to the correct model collection using the short model name (e.g. "Cyclops DE")
        if (modelShort) {
          await addProductToCollection(product.id, modelShort);
        }

        existingProducts.set(sku, {
          productId: product.id,
          variantId: variantId || null,
          inventoryItemId: inventoryItemId || null,
        });

        created++;
        onProgress({ type: "success", message: `✅ Created: "${product.title}" — price $${price}, KR, HS 920710, collection: ${modelShort || "none"}` });
      }

      // Rate-limit: ~1.67 req/s to stay within Shopify's 2 req/s burst
      await new Promise((r) => setTimeout(r, 600));

    } catch (err) {
      failed++;
      onProgress({ type: "error", message: `❌ Failed: "${title}" — ${err.message}` });
    }
  }

  onProgress({
    type: "done",
    message: `🎉 Sync complete! ${created} created, ${updated} updated, ${failed} failed.`,
    created,
    failed,
  });
}

// ─── LOCAL SERVER ──────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Serve the HTML sync UI
  if (req.method === "GET" && req.url === "/") {
    const htmlPath = path.join(__dirname, "sync-app-de.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end("sync-app-de.html not found — see setup instructions.");
    }
    return;
  }

  // ── Debug: list all Shopify DE collections ─────────────────────────────
  if (req.method === "GET" && req.url === "/collections") {
    (async () => {
      try {
        const [custom, smart] = await Promise.all([
          shopifyGet("custom_collections.json?limit=250&fields=id,title"),
          shopifyGet("smart_collections.json?limit=250&fields=id,title"),
        ]);
        const all = [
          ...(custom.custom_collections || []).map(c => `[custom]  ${c.id}  "${c.title}"`),
          ...(smart.smart_collections || []).map(c => `[smart]   ${c.id}  "${c.title}"`),
        ];
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`${all.length} collections in Shopify DE:\n\n${all.join("\n")}`);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error: " + e.message);
      }
    })();
    return;
  }

  // ── Debug: dump Airtable field names ───────────────────────────────────
  if (req.method === "GET" && req.url === "/fields") {
    (async () => {
      try {
        const records = await fetchAirtableRecords();
        const fields = records.length > 0
          ? Object.entries(records[0].fields).map(([k, v]) => `${k}: ${JSON.stringify(v).substring(0, 60)}`)
          : [];
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`${records.length} records found.\n\nFirst record fields:\n${fields.join("\n")}`);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error: " + e.message);
      }
    })();
    return;
  }

  // ── OAuth: kick off install ─────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/install") {
    const scopes = "read_products,write_products,read_inventory,write_inventory,read_locations";
    const redirectUri = encodeURIComponent(`http://localhost:${PORT}/callback`);
    const url = `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}`;
    res.writeHead(302, { Location: url });
    res.end();
    return;
  }

  // ── OAuth: exchange code for token (async-safe) ─────────────────────────
  if (req.method === "GET" && req.url.startsWith("/callback")) {
    const params = new URL(req.url, `http://localhost:${PORT}`);
    const code = params.searchParams.get("code");
    if (!code) { res.writeHead(400); res.end("Missing code."); return; }

    // Use an immediately-invoked async function so we can use await here
    (async () => {
      try {
        const tokenRes = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code }),
        });
        const rawBody = await tokenRes.text();
        console.log("Token exchange response:", tokenRes.status, rawBody.substring(0, 300));
        let tokenData;
        try { tokenData = JSON.parse(rawBody); } catch(e) { throw new Error(`Shopify returned non-JSON (status ${tokenRes.status}): ${rawBody.substring(0, 200)}`); }
        const accessToken = tokenData.access_token;
        if (!accessToken) throw new Error(JSON.stringify(tokenData));

        // Persist to .env
        const envPath = path.join(__dirname, ".env");
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
        if (envContent.includes("SHOPIFY_ACCESS_TOKEN_DE=")) {
          envContent = envContent.replace(/SHOPIFY_ACCESS_TOKEN_DE=.*/g, `SHOPIFY_ACCESS_TOKEN_DE=${accessToken}`);
        } else {
          if (!envContent.endsWith("\n")) envContent += "\n";
          envContent += `SHOPIFY_ACCESS_TOKEN_DE=${accessToken}\n`;
        }
        fs.writeFileSync(envPath, envContent);
        process.env.SHOPIFY_ACCESS_TOKEN_DE = accessToken;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#0f0f0f;color:#e8e8e8;max-width:500px;margin:80px auto;text-align:center">
          <h2 style="color:#4caf50">✅ Shopify DE connected!</h2>
          <p>Token saved to .env. You can now run syncs.</p>
          <a href="/" style="color:#D85A30;font-size:18px">→ Open sync app</a>
        </body></html>`);
        console.log("\n✅ Shopify DE access token saved to .env!\n");
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<pre style="color:red">OAuth error: ${err.message}</pre>`);
      }
    })();
    return;
  }

  // ── Setup instructions ──────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/setup") {
    const hasToken = !!process.env.SHOPIFY_ACCESS_TOKEN_DE;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Shopify DE Setup</title>
<style>body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#e8e8e8;max-width:600px;margin:60px auto;padding:0 24px}
h1{color:#D85A30}.ok{color:#4caf50}.warn{color:#ff9800}
.btn{display:inline-block;margin-top:24px;padding:14px 28px;background:#D85A30;color:#fff;font-size:16px;font-weight:700;border-radius:6px;text-decoration:none}
a{color:#D85A30}</style></head><body>
<h1>Shopify DE — One-time Setup</h1>
${hasToken
  ? '<p class="ok">✅ Token is set — <a href="/">go run a sync!</a></p>'
  : `<p class="warn">⚠️ Not connected yet. Click below to authorize:</p>
     <a class="btn" href="/install">Connect Shopify DE →</a>
     <p style="margin-top:32px;color:#666;font-size:13px">This opens Shopify's authorization page. After you approve, you'll be redirected back here and the token is saved automatically.</p>`}
</body></html>`);
    return;
  }

  // SSE endpoint: streams sync progress to the browser
  if (req.method === "GET" && req.url === "/sync") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      Connection: "keep-alive",
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    runSync(send)
      .catch((err) => send({ type: "error", message: "💥 " + err.message }))
      .finally(() => res.end());
    return;
  }

  // ── Serve logo SVG (recolored: dark fills → gold, light fills → bg dark) ───
  if (req.method === "GET" && req.url === "/logo.svg") {
    const logoPath = path.join(__dirname, "dunable-logo.svg");
    if (fs.existsSync(logoPath)) {
      const GOLD = "#e8c14a";
      const BG   = "#0a0a0a";
      let svg = fs.readFileSync(logoPath, "utf8");
      // Dark fills → gold
      [["#040404",GOLD],["#161818",GOLD],["#060606",GOLD],["#131615",GOLD],
       ["#151817",GOLD],["#060505",GOLD],["#070606",GOLD],["#a7a9a9",GOLD]]
        .forEach(([from, to]) => { svg = svg.split(from).join(to); });
      // Light fills → dark background (so stripe gaps read as dark)
      [["#e0e0df",BG],["#e6e7e7",BG],["#fff",BG],["#e1e2e2",BG]]
        .forEach(([from, to]) => { svg = svg.split(from).join(to); });
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
      res.end(svg);
    } else {
      res.writeHead(404); res.end("Logo not found — place dunable-logo.svg in the same folder as this script");
    }
    return;
  }

  // ── Dealer portal HTML page ────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/dealer") {
    const htmlPath = path.join(__dirname, "dealer-portal.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("dealer-portal.html not found in the same folder as this script.");
    }
    return;
  }

  // ── Dealer products API ────────────────────────────────────────────────────
  // Returns active products grouped by model collection, filtered to inventory > 0.
  // Checks both "active" status and non-zero inventory_quantity on the first variant.
  if (req.method === "GET" && req.url === "/api/dealer-products") {
    // Allow CORS for local development
    res.setHeader("Access-Control-Allow-Origin", "*");

    (async () => {
      try {
        // Tag → collection name mapping (check bass models first so "r2-de-bass" wins over "r2-de")
        const TAG_TO_COLLECTION = [
          ["gnarwhal-de-bass", "Gnarwhal DE Bass"],
          ["r2-de-bass",       "R2 DE Bass"],
          ["yeti-de",          "Yeti DE"],
          ["minotaur-de",      "Minotaur DE"],
          ["cyclops-de",       "Cyclops DE"],
          ["gnarwhal-de",      "Gnarwhal DE"],
          ["asteroid-de",      "Asteroid DE"],
          ["r2-de",            "R2 DE"],
        ];

        // Desired display order for collections
        const COLLECTION_ORDER = [
          "Yeti DE", "Gnarwhal DE", "Cyclops DE", "Minotaur DE",
          "Asteroid DE", "R2 DE", "Gnarwhal DE Bass", "R2 DE Bass",
        ];

        const NEW_CUTOFF_DAYS = 120; // ~4 months
        const LOW_STOCK_THRESHOLD = 5;
        const nowMs = Date.now();

        // Fetch all active products with pagination
        const allProducts = [];
        let nextUrl = `https://${SHOPIFY_STORE}/admin/api/2026-01/products.json` +
          `?status=active&limit=250&fields=id,title,body_html,variants,images,tags,created_at`;

        while (nextUrl) {
          const resp = await fetch(nextUrl, { headers: await shopifyHeaders() });
          if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Shopify products fetch failed (${resp.status}): ${err}`);
          }
          const data = await resp.json();
          if (data.products) {
            // Flag any product tagged dealer-preview
            for (const p of data.products) {
              const tags = (p.tags || "").toLowerCase().split(",").map(t => t.trim());
              if (tags.includes("dealer-preview")) p._isPreview = true;
            }
            allProducts.push(...data.products);
          }
          const link = resp.headers.get("link");
          const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
          nextUrl = next ? next[1] : null;
        }

        // Build collection groups
        const groups = {}; // collectionName → [product, ...]

        for (const p of allProducts) {
          // Only include products with inventory > 0 (preview items always shown regardless)
          const variant = p.variants && p.variants[0];
          if (!variant) continue;
          const qty = Number(variant.inventory_quantity || 0);
          if (qty <= 0 && !p._isPreview) continue;

          // Determine collection from tags
          const tags = (p.tags || "").toLowerCase().split(",").map(t => t.trim());
          let collection = "Other";
          for (const [tag, name] of TAG_TO_COLLECTION) {
            if (tags.includes(tag)) { collection = name; break; }
          }

          // Is it new? (created within last 120 days)
          const createdMs = new Date(p.created_at).getTime();
          const isNew = (nowMs - createdMs) < NEW_CUTOFF_DAYS * 24 * 60 * 60 * 1000;

          // Images (all of them)
          const images = (p.images || []).map(img => img.src);

          // Build product object for the portal
          const product = {
            id:           p.id,
            title:        p.title,
            description:  p.body_html || "",
            image:        images[0] || null,
            images,
            variantId:    variant.id,
            sku:          variant.sku || "",
            price:        Number(variant.price || 0),
            inventoryQty: qty,
            isNew,
            isPreview:    !!p._isPreview,
            isLowStock:   qty <= LOW_STOCK_THRESHOLD,
          };

          if (!groups[collection]) groups[collection] = [];
          groups[collection].push(product);
        }

        // Sort products within each group: preview items first, then alphabetically
        for (const col of Object.keys(groups)) {
          groups[col].sort((a, b) => {
            if (a.isPreview !== b.isPreview) return a.isPreview ? -1 : 1;
            return a.title.localeCompare(b.title);
          });
        }

        // Build ordered array of collection groups
        const ordered = [];
        for (const name of COLLECTION_ORDER) {
          if (groups[name] && groups[name].length > 0) {
            ordered.push({ collection: name, products: groups[name] });
          }
        }
        // Append any "Other" or unmapped collections at the end
        for (const name of Object.keys(groups)) {
          if (!COLLECTION_ORDER.includes(name) && groups[name].length > 0) {
            ordered.push({ collection: name, products: groups[name] });
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ordered));

      } catch (err) {
        console.error("Error in /api/dealer-products:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎸 Dunable DE Sync App running at http://localhost:${PORT}`);
  console.log(`   Dealer portal: http://localhost:${PORT}/dealer\n`);
});
