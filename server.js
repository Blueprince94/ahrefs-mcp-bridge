import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const app = express();
app.use(express.json());

const PROXY_KEY = process.env.PROXY_KEY || "";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";
const AHREFS_MCP_URL = process.env.AHREFS_MCP_URL || "https://api.ahrefs.com/mcp/mcp";
const BUILD_VERSION = "2026-01-17-02";

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
function recommendPackageFromRD(rdLive) {
  // PACKAGE RECOMMENDATION (Base on Referring Domains - LIVE)
  // 0-10 = 5 links
  // 10-20 = 10 links
  // 30-80 = 15 links
  // 80-120 = 20 links
  // 120-200 = 25 links
  // 200+ = at least 25 links then offer upto 50 links.

  if (rdLive <= 10) return { min: 5, max: 5, tier: "5 links" };
  if (rdLive <= 20) return { min: 10, max: 10, tier: "10 links" };
  if (rdLive < 30) return { min: 10, max: 10, tier: "10 links" }; // your gap 20-30
  if (rdLive <= 80) return { min: 15, max: 15, tier: "15 links" };
  if (rdLive <= 120) return { min: 20, max: 20, tier: "20 links" };
  if (rdLive <= 200) return { min: 25, max: 25, tier: "25 links" };
  return { min: 25, max: 50, tier: "25–50 links" };
}

function dripfeedIfOversizedOrder(rdLive, clientRequestedLinks) {
  // If client wants large amount despite low RD, allow but dripfeed 1 link every 2 days.
  if (!clientRequestedLinks) return { enabled: false };

  const rec = recommendPackageFromRD(rdLive);
  const oversized = Number(clientRequestedLinks) > Number(rec.max);

  if (rdLive <= 20 && oversized) {
    return {
      enabled: true,
      rate: "1 link every 2 days",
      reason: "Low RD footprint; slower velocity reduces risk while allowing larger order.",
    };
  }

  if (oversized) {
    return {
      enabled: true,
      rate: "1 link every 2 days",
      reason: "Requested links exceed recommended range; dripfeed reduces velocity risk.",
    };
  }

  return { enabled: false };
}

// ---------------- URL SCOPE RESOLUTION (OBJECTIVE) ----------------
function resolveTargetAndScope(input) {
  // Rule:
  // - homepage => subdomains scope
  // - innerpage => exact URL scope
  const raw = (input || "").trim();
  const forParse = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;

  let u;
  try {
    u = new URL(forParse);
  } catch {
    const hostname = raw.replace(/\/+$/g, "");
    return {
      ok: true,
      input_target: raw,
      resolved_scope: "homepage(subdomains)",
      mode: "subdomains",
      target_used: hostname,
      fullUrl: `https://${hostname}/`,
      hostname,
      isHomepage: true,
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
      target_used: hostname,
      fullUrl: `https://${hostname}/`,
      hostname,
      isHomepage: true,
    };
  }

  u.hash = "";
  const normalized = u.toString().replace(/\/+$/g, "");
  return {
    ok: true,
    input_target: raw,
    resolved_scope: "innerpage(exact)",
    mode: "exact",
    target_used: normalized,
    fullUrl: normalized,
    hostname,
    isHomepage: false,
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

  const transport = new StreamableHTTPClientTransport(new URL(AHREFS_MCP_URL), {
    requestInit: { headers },
  });

  const client = new Client({ name: "ahrefs-mcp-bridge", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch (_) {}
  }
}

function parseFirstJsonTextBlock(mcpResult) {
  const blocks = mcpResult?.content || [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      try {
        return JSON.parse(b.text);
      } catch {}
    }
  }
  return null;
}

// ---------------- ROUTES ----------------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ahrefs-mcp-bridge", version: BUILD_VERSION });
});

app.get("/recommend-links", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const target = req.query.target?.toString();
  const clientLinks = req.query.client_links ? Number(req.query.client_links) : null;

  if (!target) return res.status(400).json({ ok: false, error: "Missing required query param: target" });

  const resolved = resolveTargetAndScope(target);
  const date = new Date().toISOString().slice(0, 10);

  try {
    const result = await withAhrefsMcp(async (client) => {
      const tool = "site-explorer-backlinks-stats";

      const r = await client.callTool({
        name: tool,
        arguments: {
          target: resolved.target_used,
          mode: resolved.mode,
          date,
        },
      });

      const parsed = parseFirstJsonTextBlock(r);

      // ✅ THIS IS THE FIX:
      // Ahrefs returns RD as metrics.live_refdomains / metrics.all_time_refdomains
      const liveRD = parsed?.metrics?.live_refdomains;
      const allTimeRD = parsed?.metrics?.all_time_refdomains;

      if (liveRD === undefined || liveRD === null) {
        return {
          ok: false,
          error: "live_refdomains not returned by Ahrefs backlinks-stats.",
          enforced_rule: resolved.resolved_scope,
          target_used: resolved.target_used,
          mode_used: resolved.mode,
          date_used: date,
          tool,
          raw_json: parsed ?? null,
        };
      }

      const rdLive = Number(liveRD);
      const rdAllTime = allTimeRD == null ? null : Number(allTimeRD);

      if (Number.isNaN(rdLive)) {
        return {
          ok: false,
          error: "live_refdomains returned but is not numeric.",
          raw_json: parsed ?? null,
        };
      }

      const rec = recommendPackageFromRD(rdLive);
      const dripfeed = dripfeedIfOversizedOrder(rdLive, clientLinks);

      return {
        ok: true,
        input_target: resolved.input_target,

        // ✅ Proof we followed your rule:
        resolved_scope: resolved.resolved_scope,
        mode_used: resolved.mode,
        target_used: resolved.target_used,

        // ✅ The numbers you care about:
        referring_domains_live: rdLive,
        referring_domains_all_time: rdAllTime,

        // ✅ Recommendation uses LIVE RD:
        recommended_backlinks_min: rec.min,
        recommended_backlinks_max: rec.max,
        package_tier: rec.tier,

        dripfeed,
        date_used: date,
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
