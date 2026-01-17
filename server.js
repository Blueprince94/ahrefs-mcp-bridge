import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const app = express();
app.use(express.json());

const PROXY_KEY = process.env.PROXY_KEY || "";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";
const AHREFS_MCP_URL = process.env.AHREFS_MCP_URL || "https://api.ahrefs.com/mcp/mcp";

const BUILD_VERSION = "2026-01-17-05";

function requireProxyKey(req, res) {
  const provided = req.header("X-TRANKS-PROXY-KEY");
  if (!PROXY_KEY || !provided || provided !== PROXY_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * PACKAGE RULES (based on Referring Domains)
 * 0-10 = 5 links
 * 10-20 = 10 links
 * 30-80 = 15 links
 * 80-120 = 20 links
 * 120-200 = 25 links
 * 200+ = 25-50 links
 */
function packageFromRD(rd) {
  if (rd <= 10) return { min: 5, max: 5 };
  if (rd <= 20) return { min: 10, max: 10 };
  if (rd <= 29) return { min: 10, max: 10 }; // gap-safe
  if (rd <= 80) return { min: 15, max: 15 };
  if (rd <= 120) return { min: 20, max: 20 };
  if (rd <= 200) return { min: 25, max: 25 };
  return { min: 25, max: 50 };
}

function todayYYYYMMDD() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeTarget(input) {
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

function extractFirstJSONText(r) {
  const blocks = r?.content || [];
  for (const b of blocks) {
    if (b.type !== "text" || typeof b.text !== "string") continue;
    try {
      return JSON.parse(b.text);
    } catch {}
  }
  return null;
}

/**
 * Deep-search JSON for keys anywhere (Ahrefs MCP nesting varies)
 */
function deepFindNumber(obj, keys) {
  const wanted = new Set(keys);
  const seen = new Set();

  function walk(x) {
    if (x === null || x === undefined) return null;
    if (typeof x !== "object") return null;
    if (seen.has(x)) return null;
    seen.add(x);

    if (Array.isArray(x)) {
      for (const item of x) {
        const r = walk(item);
        if (r != null) return r;
      }
      return null;
    }

    for (const [k, v] of Object.entries(x)) {
      if (wanted.has(k) && v != null) {
        const n = Number(v);
        if (!Number.isNaN(n)) return n;
      }
    }

    for (const v of Object.values(x)) {
      const r = walk(v);
      if (r != null) return r;
    }
    return null;
  }

  return walk(obj);
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ahrefs-mcp-bridge", version: BUILD_VERSION });
});

app.get("/recommend-links", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const inputTarget = req.query.target?.toString();
  if (!inputTarget) {
    return res.status(400).json({ ok: false, error: "Missing required query param: target" });
  }

  const requestedLinksRaw = req.query.requested_links?.toString();
  const requestedLinks = requestedLinksRaw ? Number(requestedLinksRaw) : null;

  const date = (req.query.date?.toString() || todayYYYYMMDD());
  const parsed = normalizeTarget(inputTarget);

  // Rule:
  // Homepage => subdomains on hostname
  // Innerpage => exact URL
  const scopeArgs = parsed.isHomepage
    ? { target: parsed.hostname, mode: "subdomains" }
    : { target: parsed.fullUrl };

  try {
    const result = await withAhrefsMcp(async (client) => {
      const toolDebug = [];

      // ✅ 1) backlinks-stats (best source for RD)
      let r1 = null, j1 = null, err1 = null;
      try {
        r1 = await client.callTool({
          name: "site-explorer-backlinks-stats",
          arguments: {
            ...scopeArgs,
            date,
            output: "json",
          },
        });
        j1 = extractFirstJSONText(r1);
      } catch (e) {
        err1 = String(e?.message || e);
      }
      toolDebug.push({ tool: "site-explorer-backlinks-stats", args: { ...scopeArgs, date, output: "json" }, err: err1, json: j1 });

      // Try to extract RD from backlinks-stats response
      let rd_all = deepFindNumber(j1, ["refdomains", "referring_domains"]);
      let rd_dofollow = deepFindNumber(j1, ["dofollow_refdomains", "referring_domains_dofollow"]);

      // ✅ 2) referring-domains fallback (this endpoint often needs select+limit; DOES NOT require date per the tool list)
      let r2 = null, j2 = null, err2 = null;
      if (rd_all == null && rd_dofollow == null) {
        try {
          r2 = await client.callTool({
            name: "site-explorer-referring-domains",
            arguments: {
              ...scopeArgs,
              select: "dofollow_refdomains",
              limit: 1,
              order_by: "dofollow_refdomains:desc",
              output: "json",
            },
          });
          j2 = extractFirstJSONText(r2);
        } catch (e) {
          err2 = String(e?.message || e);
        }
        toolDebug.push({
          tool: "site-explorer-referring-domains",
          args: { ...scopeArgs, select: "dofollow_refdomains", limit: 1, order_by: "dofollow_refdomains:desc", output: "json" },
          err: err2,
          json: j2,
        });

        // some responses come as an array of rows; deep search catches both
        rd_all = deepFindNumber(j2, ["refdomains", "referring_domains"]) ?? rd_all;
        rd_dofollow = deepFindNumber(j2, ["dofollow_refdomains", "referring_domains_dofollow"]) ?? rd_dofollow;
      }

      // ✅ Decide what to use for package (prefer ALL ref domains to match UI better)
      const rd_used = (rd_all != null ? rd_all : rd_dofollow);

      if (rd_used == null) {
        return {
          ok: false,
          error: "RD not returned by Ahrefs tools (or tools errored).",
          debug: {
            date_used: date,
            resolved_scope: parsed.isHomepage ? "homepage(subdomains)" : "innerpage(exact-url)",
            target_used: parsed.isHomepage ? parsed.hostname : parsed.fullUrl,
            tool_debug: toolDebug, // <-- THIS will finally show the real cause
          },
        };
      }

      const pkg = packageFromRD(rd_used);

      // Dripfeed rule: if low RD but client requests bigger than recommended
      let dripfeed = { enabled: false };
      if (requestedLinks != null && !Number.isNaN(requestedLinks)) {
        if (rd_used <= 20 && requestedLinks > pkg.max) {
          dripfeed = {
            enabled: true,
            rate: "1 link every 2 days",
            reason: "Low RD footprint but larger order requested; slower velocity reduces risk.",
          };
        }
      }

      return {
        ok: true,
        build_version: BUILD_VERSION,
        date_used: date,
        input_target: inputTarget,
        resolved_scope: parsed.isHomepage ? "homepage(subdomains)" : "innerpage(exact-url)",
        target_used: parsed.isHomepage ? parsed.hostname : parsed.fullUrl,

        referring_domains_all: rd_all,
        referring_domains_dofollow: rd_dofollow,
        referring_domains_used_for_package: rd_used,

        recommended_backlinks_min: pkg.min,
        recommended_backlinks_max: pkg.max,
        dripfeed,
        debug: { tool_debug: toolDebug },
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
