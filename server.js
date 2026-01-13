import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const app = express();
app.use(express.json());

const PROXY_KEY = process.env.PROXY_KEY || "";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";

// Recommended Ahrefs MCP endpoint
const AHREFS_MCP_URL = process.env.AHREFS_MCP_URL || "https://api.ahrefs.com/mcp/mcp";

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
  res.json({ ok: true, service: "ahrefs-mcp-bridge" });
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
  const mode = (req.query.mode?.toString() || "subdomains");

  if (!target) {
    return res.status(400).json({ ok: false, error: "Missing required query param: target" });
  }

  try {
    const result = await withAhrefsMcp(async (client) => {

      // Call the real referring domains tool
      const r = await client.callTool({
        name: "site-explorer-referring-domains",
        arguments: {
          target,
          mode,
          select: "dofollow_refdomains"
        }
      });

      const blocks = r?.content || [];
      let rd = null;

      for (const b of blocks) {
        if (b.type === "text") {
          try {
            const parsed = JSON.parse(b.text);
            rd =
               parsed?.dofollow_refdomains ??
               parsed?.metrics?.dofollow_refdomains ??
  	       parsed?.summary?.dofollow_refdomains ??
              null;
            if (rd !== null) break;
          } catch {}
        }
      }

      if (rd === null) {
        return {
          ok: false,
          error: "Referring domains not found in Ahrefs response.",
          raw_result: r
        };
      }

      rd = Number(rd);
      const rec = recommendLinksFromRD(rd);

      return {
        ok: true,
        target,
        mode,
        referring_domains: rd,
        recommended_backlinks_min: rec.min,
        recommended_backlinks_max: rec.max,
        rationale: rec.rationale
      };
    });

    if (!result.ok) return res.status(502).json(result);
    res.json(result);

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Unexpected server error",
      message: String(e?.message || e)
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ahrefs-mcp-bridge running on :${port}`));
