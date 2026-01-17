import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const app = express();
app.use(express.json());

const PROXY_KEY = process.env.PROXY_KEY || "";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";
const AHREFS_MCP_URL = process.env.AHREFS_MCP_URL || "https://api.ahrefs.com/mcp/mcp";

// bump when redeploy
const BUILD_VERSION = "2026-01-17-04";

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
 * Try to find RD fields across common shapes.
 * Returns { rd_all, rd_dofollow } (numbers or null)
 */
function extractRD(json) {
  if (!json) return { rd_all: null, rd_dofollow: null };

  // common: { metrics: { refdomains, dofollow_refdomains } }
  const m = json.metrics || json.summary || json;

  const rdAll =
    m.refdomains ??
    m.referring_domains ??
    json.refdomains ??
    null;

  const rdDofollow =
    m.dofollow_refdomains ??
    m.referring_domains_dofollow ??
    json.dofollow_refdomains ??
    null;

  return {
    rd_all: rdAll != null ? Number(rdAll) : null,
    rd_dofollow: rdDofollow != null ? Number(rdDofollow) : null,
  };
}

// --- Routes ---
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
      let usedTool = null;
      let json = null;

      // ✅ 1) PRIMARY: backlinks stats (this is where RD should live)
      try {
        const r1 = await client.callTool({
          name: "site-explorer-backlinks-stats",
          arguments: { ...scopeArgs, date },
        });
        json = extractFirstJSONText(r1);
        usedTool = "site-explorer-backlinks-stats";
      } catch (e) {
        // keep going
      }

      // If RD missing, try next tool
      let { rd_all, rd_dofollow } = extractRD(json);

      // ✅ 2) FALLBACK: referring domains list endpoint (may expose dofollow_refdomains)
      if (rd_all == null && rd_dofollow == null) {
        try {
          const r2 = await client.callTool({
            name: "site-explorer-referring-domains",
            arguments: {
              ...scopeArgs,
              date,
              // ask for both if supported; if not, Ahrefs will ignore/err and we’ll report it
              select: "dofollow_refdomains,refdomains",
              limit: 1,
            },
          });
          const j2 = extractFirstJSONText(r2);
          json = j2;
          usedTool = "site-explorer-referring-domains";

          ({ rd_all, rd_dofollow } = extractRD(json));

          // Special case: sometimes returns array under "refdomains"
          if ((rd_all == null && rd_dofollow == null) && Array.isArray(j2?.refdomains) && j2.refdomains.length) {
            const first = j2.refdomains[0];
            const vAll = first?.refdomains ?? null;
            const vDo = first?.dofollow_refdomains ?? null;
            rd_all = vAll != null ? Number(vAll) : rd_all;
            rd_dofollow = vDo != null ? Number(vDo) : rd_dofollow;
          }
        } catch (e) {
          // keep going
        }
      }

      // ✅ 3) LAST RESORT: metrics (won't usually have RD, but at least gives something)
      if (rd_all == null && rd_dofollow == null) {
        try {
          const r3 = await client.callTool({
            name: "site-explorer-metrics",
            arguments: { ...scopeArgs, date },
          });
          json = extractFirstJSONText(r3);
          usedTool = "site-explorer-metrics";
          ({ rd_all, rd_dofollow } = extractRD(json));
        } catch (e) {}
      }

      if (rd_all == null && rd_dofollow == null) {
        return {
          ok: false,
          error: "RD not returned by Ahrefs tools. (backlinks-stats + referring-domains returned no RD fields)",
          debug: {
            date_used: date,
            resolved_scope: parsed.isHomepage ? "homepage(subdomains)" : "innerpage(exact-url)",
            target_used: parsed.isHomepage ? parsed.hostname : parsed.fullUrl,
            last_tool_attempted: usedTool,
            last_json: json,
          },
        };
      }

      // Prefer ALL RD if present (matches Ahrefs UI “Ref. domains” better)
      const rdForPackage = rd_all != null ? rd_all : rd_dofollow;

      const pkg = packageFromRD(rdForPackage);

      // Dripfeed rule: if low RD but client requests bigger than recommended
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
        build_version: BUILD_VERSION,
        date_used: date,

        input_target: inputTarget,
        resolved_scope: parsed.isHomepage ? "homepage(subdomains)" : "innerpage(exact-url)",
        target_used: parsed.isHomepage ? parsed.hostname : parsed.fullUrl,
        tool_used: usedTool,

        referring_domains_all: rd_all,
        referring_domains_dofollow: rd_dofollow,
        referring_domains_used_for_package: rdForPackage,

        recommended_backlinks_min: pkg.min,
        recommended_backlinks_max: pkg.max,
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
