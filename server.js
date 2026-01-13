import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const MCP_KEY = process.env.AHREFS_MCP_KEY;
const PORT = process.env.PORT || 3000;

if (!MCP_KEY) {
  console.error("❌ Missing AHREFS_MCP_KEY environment variable");
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ahrefs-mcp-bridge" });
});

app.get("/recommend-links", async (req, res) => {
  try {
    const target = req.query.target;
    if (!target) return res.status(400).json({ error: "Missing target" });

    const url = `https://mcp.ahrefs.com/v1/site-explorer/refdomains?target=${encodeURIComponent(target)}&mode=domain`;

    const r = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${MCP_KEY}`
      }
    });

    const text = await r.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: "Non-JSON from MCP", preview: text.slice(0, 300) });
    }

    const rd =
      data?.stats?.refdomains ??
      data?.metrics?.refdomains ??
      data?.refdomains_total ??
      null;

    if (!rd) {
      return res.json({ ok: false, raw: data });
    }

    let min = 5, max = 10;

    if (rd >= 20) [min, max] = [10, 20];
    if (rd >= 50) [min, max] = [20, 35];
    if (rd >= 200) [min, max] = [35, 50];

    res.json({
      target,
      referring_domains: rd,
      recommended_backlinks_min: min,
      recommended_backlinks_max: max,
      source: "ahrefs MCP"
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("✅ MCP bridge running on port", PORT);
});
