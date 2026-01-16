import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const app = express();
app.use(express.json());

const PROXY_KEY = process.env.PROXY_KEY || "";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";

// Recommended Ahrefs MCP endpoint
const AHREFS_MCP_URL = process.env.AHREFS_MCP_URL || "https://api.ahrefs.com/mcp/mcp";

// bump this whenever you redeploy so you can confirm Railway is running the new build
const BUILD_VERSION = "2026-01-17-01";

// --- Helpers ---
function requireProxyKey(req, res) {
  const provided = req.header("X-TRANKS-PROXY-KEY");
  if (!PROXY_KEY || !provided || provided !== PROXY_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * YOUR UPDATED PACKAGE RULES (RD -> package)
 * 0-10   = 5 links
 * 10-20  = 10 links
 * 30-80  = 15 links
 * 80-120 = 20 links
 * 120-200= 25 links
 * 200+   = 25-50 links
 *
 * NOTE: there is a gap for 21-29 in your rule; we map it to 10 links (safe).
 */
function packageFromRD(rd) {
  if (rd <= 10) return { min: 5, max: 5, rationale: "RD 0–10 → 5 links (start small and natural)." };
  if (rd <= 20) return { min: 10, max: 10, rationale: "RD 10–20 → 10 links (steady growth)." };
  if (rd <= 29) return { min: 10, max: 10, rationale: "RD 21–29 → 10 links (safe progression)." };
  if (rd <= 80) return { min: 15, max: 15, rationale: "RD 30–80 → 15 links (balanced increase)." };
  if (rd <= 120) return { min: 20, max: 20, rationale: "RD 80–120 → 20 links (stronger push is ok)." };
  if (rd <= 200) return { min: 25, max: 25, rationale: "RD 120–200 → 25 links (established profile)." };
  return { min: 25, max: 50, rationale: "RD 200+ → 25–50 links (scale while keeping relevance)." };
}

/**
 * Homepage vs innerpage rule:
 * - If homepage (root) -> use subdomains mode on hostname
 * - If innerpage (path exists) -> use exact URL (no mode)
 */
function normalizeAndDetect(input) {
  let raw = (input || "").trim();

  // Allow "domain.com/path" by forcing URL parseable
  if (raw && !raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = "https://" + raw;
  }

  const u = new URL(raw);
  const hostname = u.hostname.replace(/^www\./, "");
  const path = u.pathname || "/";

  const isHomepage = path === "/" || path === "";

  // Keep query string if present
  const fullUrl = `${u.protocol}//${hostname}${path}${u.search || ""}`;

  return { isHomepage, hostname, fullUrl };
}

// Create a fresh MCP client per request
async function withAhrefsMcp(fn) {
  if (!AHREFS_MCP_KEY) throw new Error("Missing AHREFS_MCP_KEY env var.");

  // Keep all three header styles (Ahrefs MCP can be picky depending on tool/client)
  const headers = {
    Authorization: `Bearer ${AHREFS_MCP_KEY}`,
    "X-Api-Token": AHREFS_MCP_KEY,
    "X-API-Key": AHREFS_MCP_KEY,
  };

  const transport = new StreamableHTTPClientTransport(
    new URL(AHREFS_MCP_URL),
    { requestInit: { headers } }
  );

  const client = new Client(
    { name: "t-ranks-ahrefs-mcp-bridge", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try { await client.close(); } catch (_) {}
  }
}

// Extract RD reliably from Ahrefs MCP tool response text blocks
function extractRDFromToolResult(r) {
  const blocks = r?.content || [];
  for (const b of blocks) {
    if (b.type !== "text" || typeof b.text !== "string") continue;
    try {
      const parsed = JSON.parse(b.text);

      // Typical shape:
      // { "refdomains": [ { "dofollow_refdomains": 123 }, ... ] }
      if (Array.isArray(parsed?.refdomains) && parsed.refdomains.length > 0) {
        const v = parsed.refdomains[0]?.dofollow_refdomains;
        if (v !== undefined && v !== null) {
          const rd = Number(v);
          if (!Number.isNaN(rd)) return rd;
        }
      }

      // Fallbacks (just in case)
      if (parsed?.dofollow_refdomains != null) {
        const rd = Number(parsed.dofollow_refdomains);
        if (!Number.isNaN(rd)) return rd;
      }
      if (parsed?.metrics?.dofollow_refdomains != null) {
        const rd = Number(parsed.metrics.dofollow_refdomains);
        if (!Number.isNaN(rd)) return rd;
      }
      if (parsed?.summary?.dofollow_refdomains != null) {
        const rd = Number(parsed.summary.dofollow_refdomains);
        if (!Number.isNaN(rd)) return rd;
      }
    } catch {
      // ignore non-json
    }
  }
  return null;
}

// --- Routes ---
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ahrefs-mcp-bridge", version: BUILD_VERSION });
});

app.get("/debug-tools", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  try {
    const out = await withAhrefsMcp(async (client) => {
      return await client.listTools();
    });

    res.json({ ok: true, mcp_url: AHREFS_MCP_URL, tools: out });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Failed to connect/list tools via Ahrefs MCP.",
      message: String(e?.message || e),
    });
  }
});

app.get("/recommend-links", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const inputTarget = req.query.target?.toString();
  if (!inputTarget) {
    return res.status(400).json({ ok: false, error: "Missing required query param: target" });
  }

  // Optional: user can request bigger order; we allow but dripfeed if RD low
  const requestedLinksRaw = req.query.requested_links?.toString();
  const requestedLinks = requestedLinksRaw ? Number(requestedLinksRaw) : null;

  try {
    const result = await withAhrefsMcp(async (client) => {
      const parsed = normalizeAndDetect(inputTarget);

      // ✅ RULE:
      // Homepage -> use hostname + mode=subdomains
      // Innerpage -> use exact URL (no mode)
      const args = parsed.isHomepage
        ? { target: parsed.hostname, mode: "subdomains", select: "dofollow_refdomains", limit: 1 }
        : { target: parsed.fullUrl, select: "dofollow_refdomains", limit: 1 };

      const r = await client.callTool({
        name: "site-explorer-referring-domains",
        arguments: args,
      });

      const rd = extractRDFromToolResult(r);

      if (rd === null || Number.isNaN(rd)) {
        return {
          ok: false,
          error: "Could not extract dofollow_refdomains from Ahrefs response.",
          raw_result: r,
          debug: { args_used: args, resolved: parsed },
        };
      }

      // Your package rules
      const pkg = packageFromRD(rd);

      // Dripfeed rule: if RD is low and they request a large amount, allow but slow down
      let dripfeed = { enabled: false };
      if (requestedLinks != null && !Number.isNaN(requestedLinks)) {
        // "large amount despite low RD" -> we'll define low RD as <= 20
        if (rd <= 20 && requestedLinks > pkg.max) {
          dripfeed = {
            enabled: true,
            rate: "1 link every 2 days",
            reason: "Low RD footprint but larger order requested; slower velocity reduces risk.",
          };
        }
      }

      return {
        ok: true,
        input_target: inputTarget,
        resolved_scope: parsed.isHomepage ? "homepage(subdomains)" : "innerpage(exact-url)",
        target_used: parsed.isHomepage ? parsed.hostname : parsed.fullUrl,

        referring_domains_dofollow: rd,

        recommended_backlinks_min: pkg.min,
        recommended_backlinks_max: pkg.max,
        rationale: pkg.rationale,

        dripfeed,
      };
    });

    if (!result.ok) return res.status(502).json(result);
    return res.json(result);

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Unexpected server error",
      message: String(e?.message || e),
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ahrefs-mcp-bridge running on :${port}`));
