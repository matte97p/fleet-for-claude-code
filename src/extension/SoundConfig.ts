import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SoundKind, SoundPlay, SoundPreset } from "../../shared/protocol";

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

/**
 * Reads claudeFleet.sound.* settings and produces the SoundPlay payload for the
 * webview. For a custom preset, the file is read here (extension host has fs)
 * and embedded as a data: URI so it plays under the webview's strict CSP.
 */
export function buildSoundPlay(event: SoundKind): SoundPlay | undefined {
  const cfg = vscode.workspace.getConfiguration("claudeFleet.sound");
  if (!cfg.get<boolean>("enabled", true)) return undefined;

  const preset = cfg.get<SoundPreset>(event, event === "permission" ? "ping" : "chime");
  const volume = clamp(cfg.get<number>("volume", 0.6), 0, 1);
  if (preset === "none") return undefined;

  let dataUri: string | undefined;
  if (preset === "custom") {
    const file = cfg.get<string>(event === "permission" ? "permissionFile" : "doneFile", "");
    dataUri = fileToDataUri(file);
    if (!dataUri) {
      void vscode.window.showWarningMessage(
        `Claude Fleet: custom ${event} sound file not found or unreadable — falling back to a built-in tone. (${file || "no path set"})`
      );
      // Fall back to a synth preset instead of silence.
      return { event, preset: event === "permission" ? "ping" : "chime", volume };
    }
  }

  return { event, preset, volume, dataUri };
}

function fileToDataUri(file: string): string | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const ext = path.extname(file).toLowerCase();
    const mime = MIME[ext] ?? "audio/mpeg";
    const b64 = fs.readFileSync(file).toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch {
    return undefined;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}
