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
  const mode = (req.query.mode?.toString() || "subdomains"); // default subdomains recommended by Ahrefs

  if (!target) {
    return res.status(400).json({ ok: false, error: "Missing required query param: target" });
  }

  // YYYY-MM-DD (Ahrefs tools require date)
  const today = new Date().toISOString().slice(0, 10);

  try {
    const result = await withAhrefsMcp(async (client) => {
      const toolName = "site-explorer-metrics";

      // Try a few argument combos (Ahrefs MCP can be strict about optional params)
      const attempts = [];

      const tryCall = async (args) => {
        try {
          const r = await client.callTool({ name: toolName, arguments: args });
          return { ok: true, args, r };
        } catch (err) {
          return { ok: false, args, err: String(err?.message || err) };
        }
      };

      // Attempt 1: minimal required + mode
      attempts.push(await tryCall({ target, date: today, mode }));

      // Attempt 2: minimal required only
      attempts.push(await tryCall({ target, date: today }));

      const success = attempts.find(a => a.ok);
      if (!success) {
        return {
          ok: false,
          error: "Could not call site-explorer-metrics successfully.",
          called: toolName,
          attempts
        };
      }

      const payload = success.r;
      const blocks = payload?.content || [];

      // Try to extract refdomains from any JSON text blocks
      let rd = null;

      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") {
          // Try JSON parse
          try {
            const parsed = JSON.parse(b.text);

            rd =
              parsed?.refdomains ??
              parsed?.referring_domains ??
              parsed?.metrics?.refdomains ??
              parsed?.metrics?.referring_domains ??
              parsed?.stats?.refdomains ??
              parsed?.stats?.referring_domains ??
              parsed?.data?.refdomains ??
              parsed?.data?.referring_domains ??
              null;

            if (rd !== null && rd !== undefined) break;
          } catch (_) {
            // ignore non-JSON blocks
          }
        }
      }

      // If still not found, return raw response so we can map the correct field name
      if (rd === null || rd === undefined || Number.isNaN(Number(rd))) {
        return {
          ok: false,
          error: "Tool call succeeded but refdomains field not found in response.",
          called_tool: { name: toolName, args: success.args },
          raw_result: payload
        };
      }

      rd = Number(rd);
      const rec = recommendLinksFromRD(rd);

      return {
        ok: true,
        target,
        mode,
        date: today,
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
