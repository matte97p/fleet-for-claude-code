import * as vscode from "vscode";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import type { SoundKind, SoundPreset } from "../../shared/protocol";

/**
 * Plays a notification sound from the **extension host** (Node) via the OS audio
 * player, so it fires regardless of whether a chat webview is open.
 *
 * The previous approach posted a "sound" message to the chat panel's webview and
 * synthesized the tone there. In a multi-session tool you're usually looking at
 * something else (no panel bound) — or the window was reloaded (the panel gets
 * disposed) — so `ChatPanel.current` was `undefined` and nothing played. Doing
 * it here removes that dependency entirely.
 *
 * Reads the same `claudeFleet.sound.*` settings as before. Best-effort: a missing
 * player or sound file never throws into the notification path.
 */

// Named presets → a macOS built-in system sound (/System/Library/Sounds/*.aiff)
// chosen to echo each preset's character. Zero bundled assets, always present.
const MAC_SOUNDS: Record<Exclude<SoundPreset, "custom" | "none">, string> = {
  ping: "Ping",
  chime: "Glass",
  blip: "Pop",
  marimba: "Tink",
  knock: "Funk",
};

export function playNotificationSound(event: SoundKind): void {
  const cfg = vscode.workspace.getConfiguration("claudeFleet.sound");
  if (!cfg.get<boolean>("enabled", true)) return;

  const preset = cfg.get<SoundPreset>(event, event === "permission" ? "ping" : "chime");
  if (preset === "none") return;

  const volume = clamp(cfg.get<number>("volume", 0.6), 0, 1);
  const customFile =
    preset === "custom"
      ? (cfg.get<string>(event === "permission" ? "permissionFile" : "doneFile", "") || "").trim()
      : "";

  try {
    if (process.platform === "darwin") playMac(preset, customFile, volume);
    else if (process.platform === "win32") playWin(event, preset, customFile);
    else playLinux(event, customFile);
  } catch {
    /* best-effort: never let sound playback break notifications */
  }
}

function playMac(preset: SoundPreset, customFile: string, volume: number): void {
  let file: string | undefined;
  if (preset === "custom") {
    if (customFile && fs.existsSync(customFile)) file = customFile;
    else warnCustomMissing(customFile);
  }
  if (!file) {
    const name = MAC_SOUNDS[preset as keyof typeof MAC_SOUNDS] ?? "Ping";
    file = `/System/Library/Sounds/${name}.aiff`;
  }
  // afplay supports -v <0..1> for volume and decodes aiff/wav/mp3/m4a.
  spawnDetached("afplay", ["-v", volume.toFixed(2), file]);
}

function playWin(event: SoundKind, preset: SoundPreset, customFile: string): void {
  if (preset === "custom" && customFile && /\.wav$/i.test(customFile) && fs.existsSync(customFile)) {
    const safe = customFile.replace(/'/g, "''");
    spawnDetached("powershell", [
      "-NoProfile",
      "-Command",
      `(New-Object System.Media.SoundPlayer '${safe}').PlaySync();`,
    ]);
    return;
  }
  if (preset === "custom") warnCustomMissing(customFile);
  // Built-in system sounds: a warning-flavored one for permission, a softer one
  // for turn-done. No file paths needed → robust across Windows versions.
  const sysSound = event === "permission" ? "Exclamation" : "Asterisk";
  spawnDetached("powershell", [
    "-NoProfile",
    "-Command",
    `[System.Media.SystemSounds]::${sysSound}.Play(); Start-Sleep -Milliseconds 700`,
  ]);
}

function playLinux(event: SoundKind, customFile: string): void {
  if (customFile && fs.existsSync(customFile)) {
    // paplay (PulseAudio/PipeWire) is the most common; falls through to canberra.
    spawnDetached("paplay", [customFile]);
    return;
  }
  if (customFile) warnCustomMissing(customFile);
  // Freedesktop sound-theme event id via libcanberra (best-effort).
  const id = event === "permission" ? "dialog-warning" : "complete";
  spawnDetached("canberra-gtk-play", ["-i", id]);
}

let warnedMissing = false;
function warnCustomMissing(file: string): void {
  if (warnedMissing) return; // once per session, don't nag
  warnedMissing = true;
  void vscode.window.showWarningMessage(
    `Claude Fleet: file audio personalizzato non trovato — uso il suono di sistema. (${file || "percorso non impostato"})`
  );
}

/** Spawn a short-lived audio player, ignoring output and any "command not found". */
function spawnDetached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* player binary not installed — ignore */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}
