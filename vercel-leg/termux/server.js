#!/usr/bin/env node
/**
 * JARVIS Termux Server — receives commands from JARVIS via HTTP.
 *
 * Setup:
 *   pkg install nodejs
 *   cd ~/jarvis-server && npm init -y && npm install express
 *   node server.js
 *
 * Exposed via cloudflared tunnel:
 *   cloudflared tunnel --url http://localhost:3900
 */
const express = require("express");
const { execSync } = require("child_process");
const os = require("os");

const app = express();
const PORT = 3900;

app.use(express.json());

// Health check
app.get("/ping", (_req, res) => {
  res.json({
    ok: true,
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: `${Math.floor(os.uptime())}s`,
  });
});

// Execute command
app.post("/execute", (req, res) => {
  const { command, timeout = 30 } = req.body || {};

  if (!command || typeof command !== "string") {
    return res.status(400).json({ success: false, error: "Missing 'command' field." });
  }

  const safeTimeout = Math.max(5, Math.min(timeout, 60));

  try {
    const result = execSync(command, {
      timeout: safeTimeout * 1000,
      encoding: "utf-8",
      maxBuffer: 1024 * 512, // 512KB
      env: { ...process.env, PATH: process.env.PATH },
    });
    res.json({ success: true, stdout: result || "", stderr: "", exit_code: 0 });
  } catch (err) {
    res.json({
      success: true,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
      exit_code: err.status || 1,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`JARVIS Termux server listening on http://0.0.0.0:${PORT}`);
});
