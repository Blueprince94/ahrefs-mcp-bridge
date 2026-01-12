import "dotenv/config";
import express from "express";
import cors from "cors";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = express();
app.use(cors());
app.use(express.json());

// Railway sets PORT automatically; fallback for local
const PORT = process.env.PORT || 8787;

// Protect your endpoints so random people can't use your bridge
const PROXY_KEY = process.env.PROXY_KEY || "";

function requireAuth(req, res) {
  const provided = req.header("X-TRANKS-PROXY-KEY") || "";
  if (!PROXY_KEY || provided !== PROXY_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function recommendLinks(rd) {
  if (rd < 20) return { min: 5, max: 10, rationale: "Low RD footprint. Start small and build a natural base." };
  if (rd < 50) return { min: 10, max: 20, rationale: "Growing profile. Add links steadily without spiking." };
  if (rd < 200) return { min: 20, max: 35, rationale: "Established baseline. You can push more volume while staying natural." };
  return { min: 35, max: 50, rationale: "Strong RD base. Higher volume is usually tolerable if relevance stays high." };
}

// Parses an MCP command string like:
// npx -y somepkg --key YOURKEY --whatever
function parseMcpCommand(command) {
  // Splits by spaces while keeping quoted chunks intact
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const cmd = parts[0];
  const args = parts.slice(1).map(p => p.replace(/^"|"$/g, ""));
  if (!cmd) throw new Error("MCP_COMMAND is empty or invalid.");
  return { cmd, args };
}

let mcpClient = null;
let toolCache = null;

async function getMcpClient() {
  if (mcpClient && toolCache) return { client: mcpClient, tools: toolCache };

  const MCP_COMMAND = process.env.MCP_COMMAND || "";
  if (!MCP_COMMAND) {
    throw new Error(
      "Missing MCP_COMMAND. Put the exact command shown by Ahrefs (MCP key modal) into Railway Variables as MCP_COMMAND."
    );
  }

  const { cmd, args } = parseMcpCommand(MCP_COMMAND);

  // Starts Ahrefs MCP server as a subprocess via stdio transport
  const transport = new StdioClientTransport({ command: cmd, args });
  const client = new Client(
    { name: "ahrefs-mcp-bridge", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  const toolsResp = await client.listTools();
  const tools = toolsResp?.tools || [];

  mcpClient = client;
  toolCache = tools;

  return { client, tools };
}

function pickRefdomainsTool(tools) {
  const names = tools.map(t => t?.name).filter(Boolean);

  const patterns = [
    /referr?ing[-_ ]?domains/i,
    /refdomains/i,
    /site[-_ ]?explorer.*ref/i,
    /backlink.*domain/i
  ];

  for (const re of patterns) {
    const hit = names.find(n => re.test(n));
    if (hit) return hit;
  }

  // fallback: just return first tool if only one exists
  return names.length === 1 ? names[0] : null;
}

function unwrapMcpResult(result) {
  // MCP often returns { content: [{type:"json", json:{...}}] } or text content
  if (result?.content && Array.isArray(result.content)) {
    const jsonItem = result.content.find(x => x?.type === "json" && x?.json);
    if (jsonItem?.json) return jsonItem.json;

    const textItem = result.content.find(x => x?.type === "text" && typeof x?.text === "string");
    if (textItem?.text) {
      // try parse text as json
      try { return JSON.parse(textItem.text); } catch { return { text: textItem.text }; }
    }
  }
  return result;
}

function extractRefdomainsCount(payload) {
  const obj = payload ?? {};

  const direct =
    obj?.refdomains_total ??
    obj?.refdomains ??
    obj?.metrics?.refdomains ??
    obj?.stats?.refdomains ??
    obj?.summary?.refdomains ??
    obj?.total ??
    obj?.data?.total;

  if (Number.isFinite(Number(direct))) return Number(direct);

  if (Array.isArray(obj?.rows)) return obj.rows.length;
  if (Array.isArray(obj?.data)) return obj.data.length;

  return null;
}

// ---------- Routes ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ahrefs-mcp-bridge" });
});

app.get("/debug-tools", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { tools } = await getMcpClient();
    res.json({ ok: true, tools });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Main endpoint you’ll call from GPT / Worker
app.get("/recommend-links", async (req, res) => {
  if (!requireAuth(req, res)) return;

  const target = String(req.query.target || "").trim();
  const mode = String(req.query.mode || "domain").trim();

  if (!target) return res.status(400).json({ error: "Missing required query param: target" });

  try {
    const { client, tools } = await getMcpClient();

    const toolName = pickRefdomainsTool(tools);
    if (!toolName) {
      return res.status(500).json({
        error: "Could not find a refdomains/referring-domains tool in MCP tool list.",
        fix: "Call /debug-tools and copy the tool names you see."
      });
    }

    const result = await client.callTool({
      name: toolName,
      arguments: { target, mode }
    });

    const payload = unwrapMcpResult(result);
    const rdCount = extractRefdomainsCount(payload);

    if (rdCount === null) {
      return res.status(502).json({
        error: "Could not extract referring domains count from MCP response.",
        tool_used: toolName,
        payload_preview: payload
      });
    }

    const rec = recommendLinks(rdCount);

    res.json({
      ok: true,
      target,
      mode,
      referring_domains: rdCount,
      recommended_backlinks_min: rec.min,
      recommended_backlinks_max: rec.max,
      rationale: rec.rationale,
      tool_used: toolName
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Bridge error", details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Ahrefs MCP Bridge running on port ${PORT}`);
});
