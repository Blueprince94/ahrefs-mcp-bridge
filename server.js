import "dotenv/config";
import express from "express";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const app = express();
app.use(express.json());

// =====================
// CONFIG (ENV VARS)
// =====================
const PORT = process.env.PORT || 3000;

// Your own protection key (required)
const PROXY_KEY = process.env.PROXY_KEY || "";

// Ahrefs MCP
const AHREFS_MCP_SERVER_URL = process.env.AHREFS_MCP_SERVER_URL || "https://api.ahrefs.com/mcp/mcp";
const AHREFS_MCP_KEY = process.env.AHREFS_MCP_KEY || "";

// =====================
// HELPERS
// =====================
function json(res, status, obj) {
  res.status(status).set("Content-Type", "application/json; charset=utf-8").send(JSON.stringify(obj, null, 2));
}

function requireProxyKey(req, res) {
  const providedKey = req.header("X-TRANKS-PROXY-KEY");
  if (!PROXY_KEY) {
    json(res, 500, { error: "Server misconfigured: missing PROXY_KEY env var" });
    return false;
  }
  if (!providedKey || providedKey !== PROXY_KEY) {
    json(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function safeNumber(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function recommendLinks(rd) {
  // 5–50 range based on Referring Domains footprint
  if (rd < 20) return { min: 5, max: 10, rationale: "Low RD footprint. Start small and build a natural base." };
  if (rd < 50) return { min: 10, max: 20, rationale: "Growing profile. Add links steadily without spiking." };
  if (rd < 200) return { min: 20, max: 35, rationale: "Established baseline. You can push more volume while staying natural." };
  return { min: 35, max: 50, rationale: "Strong RD base. Higher volume is usually tolerable if relevance stays high." };
}

// Try to extract RD count from unknown-shaped tool outputs
function extractRefdomainsCount(anyData) {
  // Common candidates we try
  const candidates = [
    anyData?.refdomains,
    anyData?.refdomains_total,
    anyData?.metrics?.refdomains,
    anyData?.stats?.refdomains,
    anyData?.summary?.refdomains,
    anyData?.data?.refdomains,
    anyData?.data?.metrics?.refdomains,
    anyData?.result?.refdomains,
    anyData?.result?.metrics?.refdomains,
    anyData?.total,
    anyData?.count,
  ].map(safeNumber);

  for (const c of candidates) {
    if (c !== null) return c;
  }

  // Fallback: scan for a key that looks like refdomains*
  if (anyData && typeof anyData === "object") {
    for (const [k, v] of Object.entries(anyData)) {
      if (/refdomains|referring[_-]?domains/i.test(k)) {
        const n = safeNumber(v);
        if (n !== null) return n;
      }
    }
  }

  return null;
}

// =====================
// MCP CLIENT (lazy + cached)
// =====================
let cached = {
  client: null,
  tools: null,
  connectedAt: 0
};

async function getMcpClient() {
  const now = Date.now();

  // Reuse connection for 10 minutes
  if (cached.client && cached.tools && (now - cached.connectedAt) < 10 * 60 * 1000) {
    return cached;
  }

  if (!AHREFS_MCP_KEY) {
    throw new Error("Missing AHREFS_MCP_KEY env var");
  }

  const client = new Client({ name: "ahrefs-mcp-bridge", version: "1.0.0" });

  // IMPORTANT: Many MCP servers accept Authorization: Bearer <key>
  const transport = new SSEClientTransport(new URL(AHREFS_MCP_SERVER_URL), {
    headers: {
      "Authorization": `Bearer ${AHREFS_MCP_KEY}`
    }
  });

  await client.connect(transport);

  const toolsResp = await client.listTools();
  const tools = toolsResp?.tools || [];

  cached = { client, tools, connectedAt: now };
  return cached;
}

function pickRefdomainsTool(tools) {
  // Try to auto-detect the best tool name for referring domains
  const preferred = tools.find(t =>
    /refdomains|referring[_-]?domains/i.test(t?.name || "")
  );

  if (preferred) return preferred.name;

  // Fallback: look in descriptions too
  const byDesc = tools.find(t =>
    /refdomains|referring domains|referring[_-]?domains/i.test(t?.description || "")
  );

  if (byDesc) return byDesc.name;

  return null;
}

// =====================
// ROUTES
// =====================
app.get("/health", (req, res) => {
  json(res, 200, {
    ok: true,
    service: "ahrefs-mcp-bridge",
    mcp_server: AHREFS_MCP_SERVER_URL
  });
});

// List tools from Ahrefs MCP (protected)
app.get("/debug-tools", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  try {
    const { tools } = await getMcpClient();
    json(res, 200, {
      ok: true,
      tool_count: tools.length,
      tools: tools.map(t => ({ name: t.name, description: t.description }))
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

// Call the “best guess” refdomains tool and show raw output (protected)
app.get("/debug-refdomains", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const target = req.query.target;
  const mode = req.query.mode || "domain";

  if (!target) return json(res, 400, { error: "Missing required query param: target" });

  try {
    const { client, tools } = await getMcpClient();
    const toolName = pickRefdomainsTool(tools);

    if (!toolName) {
      return json(res, 502, {
        ok: false,
        error: "Could not find a refdomains/referring-domains tool in MCP tool list.",
        hint: "Open /debug-tools and tell me the tool names you see."
      });
    }

    const result = await client.callTool({
      name: toolName,
      arguments: { target, mode }
    });

    // result.content is often MCP content blocks; return everything raw for debugging
    json(res, 200, {
      ok: true,
      picked_tool: toolName,
      target,
      mode,
      raw: result
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

// Main endpoint: recommend links (protected)
app.get("/recommend-links", async (req, res) => {
  if (!requireProxyKey(req, res)) return;

  const target = req.query.target;
  const mode = req.query.mode || "domain";

  if (!target) return json(res, 400, { error: "Missing required query param: target" });

  try {
    const { client, tools } = await getMcpClient();
    const toolName = pickRefdomainsTool(tools);

    if (!toolName) {
      return json(res, 502, {
        ok: false,
        error: "Could not find a refdomains/referring-domains tool in MCP tool list.",
        hint: "Hit /debug-tools to see what tools Ahrefs exposes to your MCP key."
      });
    }

    const result = await client.callTool({
      name: toolName,
      arguments: { target, mode }
    });

    // Attempt to extract number from MCP result
    // Many MCP servers return something like:
    // { content: [{ type: "text", text: "..." }] } OR { content: [{ type:"json", json: {...}}] }
    let extracted = null;

    // Try parse JSON blocks first
    const blocks = result?.content || [];
    for (const b of blocks) {
      if (b?.type === "json" && b?.json) {
        extracted = extractRefdomainsCount(b.json);
        if (extracted !== null) break;
      }
      if (b?.type === "text" && typeof b.text === "string") {
        // As a last fallback, try to find a number after "refdomains"
        const m = b.text.match(/refdomains[^0-9]*([0-9]{1,10})/i);
        if (m) {
          extracted = safeNumber(m[1]);
          if (extracted !== null) break;
        }
      }
    }

    // If not found, try the whole object
    if (extracted === null) {
      extracted = extractRefdomainsCount(result);
    }

    if (extracted === null) {
      return json(res, 502, {
        ok: false,
        error: "Could not extract Referring Domains count from MCP tool output.",
        picked_tool: toolName,
        hint: "Call /debug-refdomains to see the raw output so we can map the correct field."
      });
    }

    const rec = recommendLinks(extracted);

    return json(res, 200, {
      ok: true,
      target,
      mode,
      referring_domains: extracted,
      recommended_backlinks_min: rec.min,
      recommended_backlinks_max: rec.max,
      rationale: rec.rationale,
      notes: [
        "This recommendation uses only Referring Domains count.",
        "For best accuracy, also consider traffic trend, anchor profile, and competitor RDs."
      ]
    });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

// 404 fallback
app.use((req, res) => json(res, 404, { error: "Not found" }));

app.listen(PORT, () => {
  console.log(`ahrefs-mcp-bridge running on :${PORT}`);
  console.log(`MCP: ${AHREFS_MCP_SERVER_URL}`);
});
