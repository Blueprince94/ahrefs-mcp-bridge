import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const app = express();
app.use(express.json());

const PROXY_KEY = process.env.PROXY_KEY || "";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";
const AHREFS_MCP_URL = process.env.AHREFS_MCP_URL || "https://api.ahrefs.com/mcp/mcp";
const BUILD_VERSION = "2026-01-17-01";

// ---------------- AUTH ----------------
function requireProxyKey(req, res) {
  const provided = req.header("X-TRANKS-PROXY-KEY");
  if (!PROXY_KEY || !provided || provided !== PROXY_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------------- YOUR PACKAGE RULES ----------------
function recommendPackageFromRD(rd) {
  // USER RULES:
  // 0-10 = 5 links
  // 10-20 = 10 links
  // 30-80 = 15 links
  // 80-120 = 20 links
  // 120-200 = 25 links
  // 200+ = at least 25 links, offer up to 50 links
  //
  // NOTE: your rules skip 20-30. We'll treat 20-29 as 10 links (closest lower bracket),
  // and 21-29 is still closer to the "10 links" tier than "15 links".
  if (rd <= 10) return { min: 5, max: 5, tier: "5 links" };
  if (rd <= 20) return { min: 10, max: 10, tier: "10 links" };
  if (rd < 30) return { min: 10, max: 10, tier: "10 links" };
  if (rd <= 80) return { min: 15, max: 15, tier: "15 links" };
  if (rd <= 120) return { min: 20, max: 20, tier: "20 links" };
  if (rd <= 200) return { min: 25, max: 25, tier: "25 links" };
  return { min: 25, max: 50, tier: "25–50 links" };
}

function dripfeedIfOversizedOrder(rd, clientRequestedLinks) {
  // USER RULE: If client wants large amount despite low RD, allow but dripfeed 1 link every 2 days.
  // We'll define "low RD" as <= 20 OR clientRequested > recommended max
  if (!clientRequestedLinks) return null;

  const rec = recommendPackageFromRD(rd);
  const oversized = Number(clientRequestedLinks) > Number(rec.max);

  if (rd <= 20 && oversized) {
    return {
      enabled: true,
      rate: "1 link every 2 days",
      reason: "Low RD footprint; slower velocity reduces risk while allowing larger order."
    };
  }

  if (oversized) {
    return {
      enabled: true,
      rate: "1 link every 2 days",
      reason: "Requested links exceed recommended range; dripfeed reduces velocity risk."
    };
  }

  return { enabled: false };
}

// ---------------- URL SCOPE RESOLUTION (OBJECTIVE) ----------------
function resolveTargetAndScope(input) {
  // Accept: domain, hostname, or full URL
  // Objective rule:
  // - homepage => subdomains (domain-wide including www)
  // - innerpage => exact URL
  const raw = (input || "").trim();

  // If user passes "example.com" without protocol, add https:// for parsing only
  const forParse = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;

  let u;
  try {
    u = new URL(forParse);
  } catch {
    // fallback: treat as hostname
    const hostname = raw.replace(/\/+$/g, "");
    return {
      ok: true,
      input_target: raw,
      resolved_scope: "homepage(subdomains)",
      mode: "subdomains",
      target_used: hostname,
      fullUrl: `https://${hostname}/`,
      hostname
    };
  }

  const hostname = u.hostname;
  const path = (u.pathname || "/").trim();
  const isHomepage = path === "/" || path === "" || path === "//";

  if (isHomepage) {
    return {
      ok: true,
      input_target: raw,
      resolved_scope: "homepage(subdomains)",
      mode: "subdomains",
      target_used: hostname,              // IMPORTANT: domain only
      fullUrl: `https://${hostname}/`,
      hostname
    };
  }

  // Inner page: exact URL
  // Normalize: remove trailing slash ONLY for inner pages
  u.hash = "";
  const normalized = u.toString().replace(/\/+$/g, "");
  return {
    ok: true,
    input_target: raw,
    resolved_scope: "innerpage(exact)",
    mode: "exact",
    target_used: normalized,              // IMPORTANT: full URL
    fullUrl: normalized,
    hostname
  };
}

// ---------------- MCP CLIENT ----------------
async function withAhrefsMcp(fn) {
  if (!AHREFS_MCP_KEY) throw new Error("Missing AHREFS_MCP_KEY env var.");

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
    { name: "ahrefs-mcp-bridge", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try { await client.close(); } catch (_) {}
  }
}

// ---------------- RD EXTRACTION ----------------
function tryExtractRD(parsed) {
  // We want "Referring Domains" like Ahrefs UI count (page/domain scope dependent).
  // Try common field names that Ahrefs tools may return.
  return (
    parsed?.refdomains ??
    parsed?.referring_domains ??
    parsed?.metrics?.refdomains ??
    parsed?.metrics?.referring_domains ??
    parsed?.stats?.refdomains ??
    parsed?.stats?.referring_domains ??
    null
  );
}

function parseFirstJsonTextBlock(mcpResult) {
  const blocks = mcpResult?.content || [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      try {
        return JSON.parse(b.text);
      } catch {
        // ignore
      }
    }
  }
  return null;
}

// ---------------- ROUTES ----------------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ahrefs-mcp-bridge", version: BUILD_VERSION });
});

app.get("/debug-tools", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  try {
    const out = await withAhrefsMcp(async (client) => client.listTools());
    res.json({ ok: true, mcp_url: AHREFS_MCP_URL, tools: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to list tools", message: String(e?.message || e) });
  }
});

/**
 * GET /recommend-links?target=<url_or_domain>&client_links=<optional number>
 * Uses the objective rule:
 * - homepage -> mode=subdomains, target_used=hostname
 * - innerpage -> mode=exact, target_used=full URL
 */
app.get("/recommend-links", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const target = req.query.target?.toString();
  const clientLinks = req.query.client_links ? Number(req.query.client_links) : null;

  if (!target) return res.status(400).json({ ok: false, error: "Missing required query param: target" });

  const resolved = resolveTargetAndScope(target);
  if (!resolved.ok) return res.status(400).json({ ok: false, error: "Invalid target" });

  // Ahrefs MCP tools often require a date argument.
  const date = new Date().toISOString().slice(0, 10);

  try {
    const result = await withAhrefsMcp(async (client) => {
      // 1) Use backlinks-stats FIRST (best chance to match UI counts)
      let usedTool = "site-explorer-backlinks-stats";
      let r1;
      try {
        r1 = await client.callTool({
          name: "site-explorer-backlinks-stats",
          arguments: {
            target: resolved.target_used,
            mode: resolved.mode,
            date
          }
        });
      } catch (err) {
        // If "exact" mode isn't accepted by this tool, return the error clearly (do NOT silently switch scope)
        return {
          ok: false,
          error: "Ahrefs tool call failed for backlinks-stats with the enforced scope rule.",
          enforced_rule: resolved.resolved_scope,
          target_used: resolved.target_used,
          mode_used: resolved.mode,
          date_used: date,
          tool: usedTool,
          message: String(err?.message || err)
        };
      }

      const parsed1 = parseFirstJsonTextBlock(r1);
      const rd1 = tryExtractRD(parsed1);

      if (rd1 === null || rd1 === undefined || Number.isNaN(Number(rd1))) {
        // Fail hard instead of returning wrong numbers from unrelated fields.
        return {
          ok: false,
          error: "Referring Domains not found in backlinks-stats response (no refdomains/referring_domains fields).",
          enforced_rule: resolved.resolved_scope,
          target_used: resolved.target_used,
          mode_used: resolved.mode,
          date_used: date,
          tool: usedTool,
          raw_json: parsed1 ?? null
        };
      }

      const rd = Number(rd1);
      const rec = recommendPackageFromRD(rd);
      const dripfeed = dripfeedIfOversizedOrder(rd, clientLinks);

      return {
        ok: true,
        input_target: resolved.input_target,
        resolved_scope: resolved.resolved_scope,
        target_used: resolved.target_used,
        mode_used: resolved.mode,
        date_used: date,

        referring_domains: rd,

        recommended_backlinks_min: rec.min,
        recommended_backlinks_max: rec.max,
        package_tier: rec.tier,

        dripfeed: dripfeed,
      };
    });

    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: "Unexpected server error", message: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ahrefs-mcp-bridge running on :${port}`));
