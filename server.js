import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const MCP_KEY = process.env.AHREFS_MCP_KEY;
const PORT = process.env.PORT || 3000;

/* Health check */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ahrefs-mcp-bridge" });
});

/* DEBUG: test MCP connectivity */
app.get("/debug-mcp", async (req, res) => {
  try {
    const r = await fetch("https://mcp.ahrefs.com/v1/tools", {
      headers: { Authorization: `Bearer ${MCP_KEY}` }
    });
    const text = await r.text();
    res.status(200).send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* MAIN: get referring domains + recommend links */
app.get("/recommend-links", async (req, res) => {
  const target = req.query.target;
  if (!target) return res.status(400).json({ error: "Missing target" });

  try {
    const r = await fetch("https://mcp.ahrefs.com/v1/run", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MCP_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tool: "site_explorer_refdomains",
        input: { target }
      })
    });

    const data = await r.json();

    const rd =
      data?.result?.stats?.refdomains ||
      data?.result?.refdomains ||
      0;

    let min = 5, max = 10;
    if (rd > 50) { min = 10; max = 20; }
    if (rd > 200) { min = 20; max = 35; }
    if (rd > 500) { min = 35; max = 50; }

    res.json({
      target,
      referring_domains: rd,
      recommended_links: `${min}–${max}`,
      basis: "Ahrefs MCP referring domains"
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("MCP bridge running on port", PORT);
});
