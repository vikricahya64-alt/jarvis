#!/usr/bin/env node
/**
 * JARVIS Bridge Server — runs inside AnyClaw Terminal.
 * Exposes HTTP API for JARVIS to execute commands on the phone.
 *
 * Setup (in AnyClaw Terminal):
 *   mkdir -p ~/jarvis-bridge && cd ~/jarvis-bridge
 *   npm init -y && npm install express
 *   # paste this file as server.js
 *   node server.js
 *
 * Then open cloudflared tunnel:
 *   cloudflared tunnel --url http://localhost:3900
 */
const express = require("express");
const { execSync } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3900;

app.use(express.json());

// Health check
app.get("/ping", (_req, res) => {
  res.json({
    ok: true,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: `${Math.floor(os.uptime())}s`,
    memory: {
      free: `${Math.floor(os.freemem() / 1024 / 1024)}MB`,
      total: `${Math.floor(os.totalmem() / 1024 / 1024)}MB`,
    },
  });
});

// Execute shell command
app.post("/execute", (req, res) => {
  const { command, timeout = 30, workdir } = req.body || {};

  if (!command || typeof command !== "string") {
    return res.status(400).json({ success: false, error: "Missing 'command'." });
  }

  const safeTimeout = Math.max(5, Math.min(timeout, 60));
  const cwd = workdir && fs.existsSync(workdir) ? workdir : os.homedir();

  try {
    const result = execSync(command, {
      timeout: safeTimeout * 1000,
      encoding: "utf-8",
      maxBuffer: 1024 * 512,
      cwd,
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

// Read file
app.post("/readfile", (req, res) => {
  const { filepath } = req.body || {};
  if (!filepath) return res.status(400).json({ success: false, error: "Missing 'filepath'." });

  try {
    const content = fs.readFileSync(filepath, "utf-8");
    res.json({ success: true, content: content.slice(0, 50000) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Write file
app.post("/writefile", (req, res) => {
  const { filepath, content } = req.body || {};
  if (!filepath || content === undefined) {
    return res.status(400).json({ success: false, error: "Missing 'filepath' or 'content'." });
  }

  try {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, content, "utf-8");
    res.json({ success: true, bytes: Buffer.byteLength(content) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// List directory
app.post("/listdir", (req, res) => {
  const { dirpath = "." } = req.body || {};

  try {
    const items = fs.readdirSync(dirpath, { withFileTypes: true });
    const result = items.map((item) => ({
      name: item.name,
      type: item.isDirectory() ? "dir" : "file",
    }));
    res.json({ success: true, items: result.slice(0, 200) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`JARVIS Bridge running on http://0.0.0.0:${PORT}`);
});
