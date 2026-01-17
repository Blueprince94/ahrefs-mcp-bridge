import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const app = express();
app.use(express.json());

const PROXY_KEY = process.env.PROXY_KEY || "";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";
const AHREFS_MCP_URL = process.env.AHREFS_MCP_URL || "https://api.ahrefs.com/mcp/mcp";

// bump this whenever you redeploy so you can confirm Railway is running new build
const BUILD_VERSION = "2026-01-17-02";

// -------------------- Helpers --------------------
function requireProxyKey(req, res) {
  const provided = req.header("X-TRANKS-PROXY-KEY");
  if (!PROXY_KEY || !provided || provided !== PROXY_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function todayISO() {
  // Ahrefs MCP tools often require date (YYYY-MM-DD)
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseTarget(input) {
  // Accepts:
  // - stellarrank.net
  // - https://stellarrank.net
  // - https://stellarrank.net/pricing
  // Returns: { isHomepage, hostname, fullUrl, normalizedInput }
  let normalizedInput = (input || "").trim();
  if (!normalizedInput) throw new Error("Missing target");

  // If no protocol, add https for parsing only
  const forUrl = normalizedInput.startsWith("http://") || normalizedInput.startsWith("https://")
    ? normalizedInput
    : `https://${normalizedInput}`;

  let u;
  try {
    u = new URL(forUrl);
  } catch {
    throw new Error("Invalid target URL/domain");
  }

  const hostname = u.hostname.replace(/^www\./, "");
  const pathname = u.pathname || "/";

  // homepage if path is "/" OR empty
  const isHomepage = pathname === "/" || pathname === "";

  const fullUrl = `https://${hostname}${pathname}${u.search || ""}`;

  return { isHomepage, hostname, fullUrl, normalizedInput };
}

function enforceScopeRule(inputTarget) {
  const resolved = parseTarget(inputTarget);

  // RULE:
  // homepage => mode=subdomains, target_used=hostname
  // innerpage => mode=exact, target_used=fullUrl
  if (resolved.isHomepage) {
    return {
      resolved_scope: "homepage(subdomains)",
      mode_used: "subdomains",
      target_used: resolved.hostname,
      resolved,
    };
  }

  return {
    resolved_scope: "innerpage(exact)",
    mode_used: "exact",
    target_used: resolved.fullUrl,
    resolved,
  };
}

// PACKAGE RECOMMENDATION (based on LIVE referring domains)
function packageFromRD(rdLive) {
  const rd = Number(rdLive);

  // Your tiers (filled the missing 21–29 gap by extending the 30–80 tier downwards safely)
  if (rd <= 10) return { min: 5, max: 5, tier: "5 links" };
  if (rd <= 20) return { min: 10, max: 10, tier: "10 links" };
  if (rd <= 80) return { min: 15, max: 15, tier: "15 links" };
  if (rd <= 120) return { min: 20, max: 20, tier: "20 links" };
  if (rd <= 200) return { min: 25, max: 25, tier: "25 links" };

  // 200 above: at least 25, offer up to 50
  return { min: 25, max: 50, tier: "25–50 links" };
}

// DRIPFEED RULE (based on LIVE referring domains)
function dripfeedFromRD(rdLive) {
  const rd = Number(rdLive);

  if (rd <= 20) {
    return { enabled: true, rate: "1 link every 2 days", reason: "Low RD (0–20) — slower velocity is safer." };
  }
  if (rd <= 100) {
    return { enabled: true, rate: "1 link per day", reason: "Moderate RD (21–100) — steady daily growth." };
  }
  return { enabled: true, rate: "2–3 links per day", reason: "Strong RD (101+) — can sustain faster pacing." };
}

// -------------------- MCP Client --------------------
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

// -------------------- Routes --------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ahrefs-mcp-bridge", version: BUILD_VERSION });
});

app.get("/debug-tools", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  try {
    const out = await withAhrefsMcp(async (client) => await client.listTools());
    res.json({ ok: true, mcp_url: AHREFS_MCP_URL, tools: out });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Failed to connect/list tools via Ahrefs MCP.",
      message: String(e?.message || e),
    });
  }
});

/**
 * GET /recommend-links?target=...  (target can be homepage or innerpage URL)
 * Optional:
 * - desired_links=number  (if client wants bigger than recommended; we still allow, but dripfeed remains RD-based)
 */
app.get("/recommend-links", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const input_target = req.query.target?.toString();
  const desired_links = req.query.desired_links ? Number(req.query.desired_links) : null;

  if (!input_target) {
    return res.status(400).json({ ok: false, error: "Missing required query param: target" });
  }

  const date = todayISO();
  const enforced = enforceScopeRule(input_target);

  try {
    const result = await withAhrefsMcp(async (client) => {
      // We use backlinks-stats because it reliably returns live_refdomains/all_time_refdomains
      // and is aligned with “live referring domains” requirement.
      const toolName = "site-explorer-backlinks-stats";

      const r = await client.callTool({
        name: toolName,
        arguments: {
          target: enforced.target_used,
          mode: enforced.mode_used,
          date,
          select: "live_refdomains,all_time_refdomains",
          limit: 1,
        },
      });

      const blocks = r?.content || [];
      let live = null;
      let allTime = null;
      let lastJson = null;

      for (const b of blocks) {
        if (b.type !== "text" || typeof b.text !== "string") continue;
        try {
          const parsed = JSON.parse(b.text);
          lastJson = parsed;

          // common shape: { metrics: { live_refdomains, all_time_refdomains } }
          if (parsed?.metrics) {
            if (parsed.metrics.live_refdomains != null) live = Number(parsed.metrics.live_refdomains);
            if (parsed.metrics.all_time_refdomains != null) allTime = Number(parsed.metrics.all_time_refdomains);
          }

          // fallback if returned flat
          if (live == null && parsed?.live_refdomains != null) live = Number(parsed.live_refdomains);
          if (allTime == null && parsed?.all_time_refdomains != null) allTime = Number(parsed.all_time_refdomains);

          if (live != null && !Number.isNaN(live)) break;
        } catch {
          // ignore non-json
        }
      }

      if (live == null || Number.isNaN(live)) {
        return {
          ok: false,
          error: "Could not extract live_refdomains from Ahrefs response.",
          debug: {
            tool: toolName,
            date_used: date,
            enforced_rule: enforced.resolved_scope,
            args_used: { target: enforced.target_used, mode: enforced.mode_used, date },
            last_json: lastJson,
            raw_result: r,
          },
        };
      }

      if (allTime == null || Number.isNaN(allTime)) allTime = live; // safe fallback

      const pkg = packageFromRD(live);
      const drip = dripfeedFromRD(live);

      // If client requests bigger than recommended max, allow but keep dripfeed (still RD-based rule)
      const override = (desired_links != null && !Number.isNaN(desired_links) && desired_links > pkg.max)
        ? {
            requested_links: desired_links,
            allowed: true,
            note: "Requested links exceed the recommended tier. Allowed, but pacing must follow dripfeed guidance.",
          }
        : null;

      return {
        ok: true,

        input_target,
        resolved_scope: enforced.resolved_scope,
        mode_used: enforced.mode_used,
        target_used: enforced.target_used,

        referring_domains_live: live,
        referring_domains_all_time: allTime,

        recommended_backlinks_min: pkg.min,
        recommended_backlinks_max: pkg.max,
        package_tier: pkg.tier,

        dripfeed: drip, // ALWAYS enabled per your rule

        ...(override ? { override } : {}),
        date_used: date,
      };
    });

    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Unexpected server error",
      message: String(e?.message || e),
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ahrefs-mcp-bridge running on :${port}`));
