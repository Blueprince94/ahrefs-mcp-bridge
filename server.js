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
const BUILD_VERSION = "2026-01-14-01";

// --- Helpers ---
function requireProxyKey(req, res) {
  const provided = req.header("X-TRANKS-PROXY-KEY");
  if (!PROXY_KEY || !provided || provided !== PROXY_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

function recommendLinksFromRD(rd) {
  if (rd < 20) return { min: 5, max: 10, rationale: "Low RD footprint. Start small and build a natural base." };
  if (rd < 50) return { min: 10, max: 20, rationale: "Growing profile. Add links steadily without spiking." };
  if (rd < 200) return { min: 20, max: 35, rationale: "Established baseline. You can push more volume while staying natural." };
  return { min: 35, max: 50, rationale: "Strong RD base. Higher volume is usually tolerable if relevance stays high." };
}

// Create a fresh MCP client per request
async function withAhrefsMcp(fn) {
  if (!AHREFS_MCP_KEY) throw new Error("Missing AHREFS_MCP_KEY env var.");

  // keep all three header styles (Ahrefs MCP has been picky depending on tool/client)
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

  const target = req.query.target?.toString();
  const mode = (req.query.mode?.toString() || "subdomains"); // keep default subdomains

  if (!target) {
    return res.status(400).json({ ok: false, error: "Missing required query param: target" });
  }

  try {
    const result = await withAhrefsMcp(async (client) => {
      // IMPORTANT:
      // This tool returns rows (often as { refdomains: [...] }) not a single number.
      // We request limit=1 to make extraction deterministic.
      const r = await client.callTool({
        name: "site-explorer-referring-domains",
        arguments: {
          target,
          mode,
          select: "dofollow_refdomains",
          limit: 1,
          // optional (uncomment if you want to filter obvious spam)
          // where: "is_spam=0",
          // order_by: "dofollow_refdomains:desc",
        },
      });

      const blocks = r?.content || [];
      let rd = null;

      for (const b of blocks) {
        if (b.type !== "text" || typeof b.text !== "string") continue;

        try {
          const parsed = JSON.parse(b.text);

          // ✅ Case A: Ahrefs returns an array under "refdomains"
          if (Array.isArray(parsed?.refdomains) && parsed.refdomains.length > 0) {
            const v = parsed.refdomains[0]?.dofollow_refdomains;
            if (v !== undefined && v !== null) {
              rd = Number(v);
              if (!Number.isNaN(rd)) break;
            }
          }

          // ✅ Case B: Ahrefs returns a direct value (fallback)
          if (parsed?.dofollow_refdomains !== undefined && parsed.dofollow_refdomains !== null) {
            rd = Number(parsed.dofollow_refdomains);
            if (!Number.isNaN(rd)) break;
          }

          // ✅ Additional fallbacks (just in case)
          if (parsed?.metrics?.dofollow_refdomains != null) {
            rd = Number(parsed.metrics.dofollow_refdomains);
            if (!Number.isNaN(rd)) break;
          }
          if (parsed?.summary?.dofollow_refdomains != null) {
            rd = Number(parsed.summary.dofollow_refdomains);
            if (!Number.isNaN(rd)) break;
          }
        } catch {
          // ignore non-json text
        }
      }

      if (rd === null || Number.isNaN(rd)) {
        return {
          ok: false,
          error: "Could not extract dofollow_refdomains from Ahrefs response.",
          hint: "Check raw_result -> content text. If it contains refdomains array, we use [0].dofollow_refdomains.",
          raw_result: r,
        };
      }

      const rec = recommendLinksFromRD(rd);

      return {
        ok: true,
        target,
        mode,
        referring_domains_dofollow: rd,
        recommended_backlinks_min: rec.min,
        recommended_backlinks_max: rec.max,
        rationale: rec.rationale,
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
