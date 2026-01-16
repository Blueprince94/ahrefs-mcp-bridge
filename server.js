import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const app = express();
app.use(express.json());

const PROXY_KEY = process.env.PROXY_KEY || "";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";

const AHREFS_MCP_URL = process.env.AHREFS_MCP_URL || "https://api.ahrefs.com/mcp/mcp";
const BUILD_VERSION = "2026-01-17-02";

function requireProxyKey(req, res) {
  const provided = req.header("X-TRANKS-PROXY-KEY");
  if (!PROXY_KEY || !provided || provided !== PROXY_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * PACKAGE RULES (based on Referring Domains - ALL)
 * 0-10   = 5 links
 * 10-20  = 10 links
 * 30-80  = 15 links
 * 80-120 = 20 links
 * 120-200= 25 links
 * 200+   = 25-50 links
 */
function packageFromRD(rdAll) {
  if (rdAll <= 10) return { min: 5, max: 5 };
  if (rdAll <= 20) return { min: 10, max: 10 };
  if (rdAll <= 29) return { min: 10, max: 10 }; // gap-safe
  if (rdAll <= 80) return { min: 15, max: 15 };
  if (rdAll <= 120) return { min: 20, max: 20 };
  if (rdAll <= 200) return { min: 25, max: 25 };
  return { min: 25, max: 50 };
}

function normalizeAndDetect(input) {
  let raw = (input || "").trim();
  if (raw && !raw.startsWith("http://") && !raw.startsWith("https://")) raw = "https://" + raw;

  const u = new URL(raw);
  const hostname = u.hostname.replace(/^www\./, "");
  const path = u.pathname || "/";
  const isHomepage = path === "/" || path === "";

  const fullUrl = `${u.protocol}//${hostname}${path}${u.search || ""}`;
  return { isHomepage, hostname, fullUrl };
}

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

function extractNumbersFromJSONTextBlocks(r) {
  const blocks = r?.content || [];
  for (const b of blocks) {
    if (b.type !== "text" || typeof b.text !== "string") continue;
    try {
      return JSON.parse(b.text);
    } catch {}
  }
  return null;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ahrefs-mcp-bridge", version: BUILD_VERSION });
});

app.get("/debug-tools", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  try {
    const out = await withAhrefsMcp(async (client) => await client.listTools());
    res.json({ ok: true, mcp_url: AHREFS_MCP_URL, tools: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to connect/list tools via Ahrefs MCP.", message: String(e?.message || e) });
  }
});

app.get("/recommend-links", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const inputTarget = req.query.target?.toString();
  if (!inputTarget) return res.status(400).json({ ok: false, error: "Missing required query param: target" });

  const requestedLinksRaw = req.query.requested_links?.toString();
  const requestedLinks = requestedLinksRaw ? Number(requestedLinksRaw) : null;

  try {
    const result = await withAhrefsMcp(async (client) => {
      const parsed = normalizeAndDetect(inputTarget);

      const args = parsed.isHomepage
        ? { target: parsed.hostname, mode: "subdomains" }
        : { target: parsed.fullUrl };

      // 1) Try site-explorer-metrics (best match for “overview”)
      let metricsResp = null;
      try {
        metricsResp = await client.callTool({
          name: "site-explorer-metrics",
          arguments: { ...args, limit: 1 },
        });
      } catch (_) {}

      let data = metricsResp ? extractNumbersFromJSONTextBlocks(metricsResp) : null;

      // 2) Fallback: site-explorer-backlinks-stats
      if (!data) {
        const backlinksStatsResp = await client.callTool({
          name: "site-explorer-backlinks-stats",
          arguments: { ...args, limit: 1 },
        });
        data = extractNumbersFromJSONTextBlocks(backlinksStatsResp);
      }

      if (!data) {
        return { ok: false, error: "Could not parse Ahrefs response JSON.", debug: { args_used: args, resolved: parsed } };
      }

      // Attempt to find both ALL and DOFOLLOW RD in typical locations
      const rdAll =
        data?.metrics?.refdomains ??
        data?.refdomains ??
        data?.summary?.refdomains ??
        null;

      const rdDofollow =
        data?.metrics?.dofollow_refdomains ??
        data?.dofollow_refdomains ??
        data?.summary?.dofollow_refdomains ??
        null;

      if (rdAll == null && rdDofollow == null) {
        return { ok: false, error: "No RD fields found (refdomains / dofollow_refdomains).", raw: data, debug: { args_used: args, resolved: parsed } };
      }

      // Choose ALL RD for package logic (matches Ahrefs UI better)
      const rdForPackage = rdAll != null ? Number(rdAll) : Number(rdDofollow);
      const pkg = packageFromRD(rdForPackage);

      // Dripfeed rule
      let dripfeed = { enabled: false };
      if (requestedLinks != null && !Number.isNaN(requestedLinks)) {
        if (rdForPackage <= 20 && requestedLinks > pkg.max) {
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

        referring_domains_all: rdAll != null ? Number(rdAll) : null,
        referring_domains_dofollow: rdDofollow != null ? Number(rdDofollow) : null,

        package_basis: rdAll != null ? "all_refdomains" : "dofollow_refdomains",
        referring_domains_used_for_package: rdForPackage,

        recommended_backlinks_min: pkg.min,
        recommended_backlinks_max: pkg.max,

        dripfeed,
      };
    });

    if (!result.ok) return res.status(502).json(result);
    return res.json(result);

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Unexpected server error", message: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ahrefs-mcp-bridge running on :${port}`));
