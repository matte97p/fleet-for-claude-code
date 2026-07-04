#!/usr/bin/env node
// One-shot recovery: copy the old extension's globalState (publisher `matteo`)
// into the new extension id (publisher `matte97p`), so chats/folders created
// before the publisher rename reappear.
//
// MUST be run with VS Code FULLY QUIT (Cmd-Q, not just the window) — the state
// DB is shared by all of VS Code and writing to it live can corrupt it.
//
//   node scripts/migrate-globalstate.mjs
//
// Source of truth: lab/fleetview/.old-chats-backup.json (the exact JSON blob
// extracted from the old key). Target key: matte97p.claude-fleet.

import { execFileSync } from "node:child_process";
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NEW_KEY = "matte97p.claude-fleet";
const DB = join(homedir(), "Library/Application Support/Code/User/globalStorage/state.vscdb");
const BACKUP_JSON = join(import.meta.dirname, "..", ".old-chats-backup.json");

// 1) Refuse to run while VS Code is open.
try {
  const out = execFileSync("pgrep", ["-x", "Code"], { encoding: "utf8" }).trim();
  if (out) {
    console.error("✗ VS Code sembra aperto (pid " + out + "). Chiudilo del tutto (Cmd-Q) e riprova.");
    process.exit(1);
  }
} catch {
  /* pgrep exits non-zero when nothing matches → good, VS Code is closed */
}

if (!existsSync(DB)) { console.error("✗ state.vscdb non trovato:", DB); process.exit(1); }
if (!existsSync(BACKUP_JSON)) { console.error("✗ backup non trovato:", BACKUP_JSON); process.exit(1); }

const value = readFileSync(BACKUP_JSON, "utf8").trim();
JSON.parse(value); // validate it's real JSON before touching the DB

// 2) Back up the DB next to itself.
const bak = DB + ".fleet-bak";
copyFileSync(DB, bak);
console.log("• backup DB →", bak);

// 3) Upsert the value under the new extension id (parameter-bound, no escaping issues).
const sql = `import sqlite3, sys
db = sqlite3.connect(${JSON.stringify(DB)})
val = sys.stdin.read()
db.execute("INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)", (${JSON.stringify(NEW_KEY)}, val))
db.commit(); db.close()
print("ok")`;
const res = execFileSync("python3", ["-c", sql], { input: value, encoding: "utf8" });
console.log("• migrazione:", res.trim());
console.log("✓ Fatto. Riapri VS Code: le vecchie chat/cartelle sono sotto", NEW_KEY);
