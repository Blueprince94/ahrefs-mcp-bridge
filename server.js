import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const app = express();
app.use(express.json());

/**
 * ENV you must set on Railway:
 * - PROXY_KEY   (your own header key: tranks_proxy_2026 etc)
 * - AHREFS_MCP_KEY (the MCP key you generated in Ahrefs)
 *
 * Optional:
 * - PORT (Railway usually injects this automatically)
 */
const PROXY_KEY = process.env.PROXY_KEY || "";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";

// Ahrefs remote MCP endpoint (Ahrefs provides a remote MCP server).
// One public reference shows:
const AHREFS_MCP_URL = "https://api.ahrefs.com/mcp/mcp";

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

// Create a fresh MCP client per request (simple + reliable for now)
async function withAhrefsMcp(fn) {
  if (!AHREFS_MCP_KEY) throw new Error("Missing AHREFS_MCP_KEY env var.");

  // Most MCP servers authenticate using headers.
  // We'll send BOTH common patterns to avoid guessing wrong:
  const headers = {
    "Authorization": `Bearer ${AHREFS_MCP_KEY}`,
    "X-API-Key": AHREFS_MCP_KEY
  };

  const transport = new SSEClientTransport(new URL(AHREFS_MCP_URL), { headers });
  const client = new Client({ name: "t-ranks-ahrefs-mcp-bridge", version: "1.0.0" }, { capabilities: {} });

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
      const tools = await client.listTools();
      return tools;
    });

    res.json({ ok: true, mcp_url: AHREFS_MCP_URL, tools: out });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Failed to connect/list tools via Ahrefs MCP.",
      message: String(e?.message || e)
    });
  }
});

/**
 * This endpoint will:
 * 1) call Ahrefs MCP tool(s) to get Referring Domains count for target
 * 2) return a 5–50 backlink recommendation
 *
 * NOTE: Tool names/params depend on Ahrefs MCP tool schema.
 * So we do a resilient approach:
 * - we try a few likely tool names / param sets
 * - if it still fails, we return the tools list guidance
 */
app.get("/recommend-links", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const target = req.query.target?.toString();
  const mode = (req.query.mode?.toString() || "domain");

  if (!target) {
    return res.status(400).json({ ok: false, error: "Missing required query param: target" });
  }

  try {
    const result = await withAhrefsMcp(async (client) => {
      // See what tools exist
      const toolsResp = await client.listTools();
      const tools = toolsResp?.tools || [];

      // helper to try calling tool
      const tryCall = async (name, args) => {
        try {
          const r = await client.callTool({ name, arguments: args });
          return { ok: true, name, args, r };
        } catch (err) {
          return { ok: false, name, args, err: String(err?.message || err) };
        }
      };

      // Try a few plausible tool names + args
      const attempts = [];

      // Common patterns across MCP SEO tools
      attempts.push(await tryCall("site_explorer_refdomains", { target, mode }));
      attempts.push(await tryCall("site_explorer_refdomains", { target, mode, output: "json" }));
      attempts.push(await tryCall("refdomains", { target, mode }));
      attempts.push(await tryCall("referring_domains", { target, mode }));
      attempts.push(await tryCall("site_explorer_overview", { target, mode }));

      const success = attempts.find(a => a.ok);

      if (!success) {
        return {
          ok: false,
          error: "Could not call an Ahrefs MCP tool successfully (tool name/args mismatch).",
          hint: "Open /debug-tools to see the exact tool names + required params, then we’ll map it to RD count.",
          tools_available: tools.map(t => ({ name: t.name, description: t.description })),
          attempts
        };
      }

      // Extract refdomains from tool output (best-effort)
      const payload = success.r;
      const textBlocks = payload?.content || [];

      // MCP tool results often come as text/json blocks.
      // We'll search for a number field in any JSON-like text.
      let rd = null;

      for (const b of textBlocks) {
        if (b.type === "text" && typeof b.text === "string") {
          // try JSON parse
          try {
            const parsed = JSON.parse(b.text);
            rd =
              parsed?.refdomains ??
              parsed?.referring_domains ??
              parsed?.metrics?.refdomains ??
              parsed?.summary?.refdomains ??
              parsed?.stats?.refdomains ??
              null;
            if (rd !== null && rd !== undefined) break;
          } catch (_) {
            // ignore
          }
        }
      }

      // If we still don't have rd, fail with debug data
      if (rd === null || rd === undefined || Number.isNaN(Number(rd))) {
        return {
          ok: false,
          error: "Tool call succeeded but could not extract Referring Domains count from response.",
          called_tool: { name: success.name, args: success.args },
          raw_result: payload
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

    // result already structured
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

// --- Start ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ahrefs-mcp-bridge running on :${port}`));
