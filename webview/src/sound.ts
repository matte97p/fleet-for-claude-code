// Notification sounds. Built-in presets are synthesized with the Web Audio API
// (no asset files → CSP-safe); a "custom" preset plays a data: URI provided by
// the extension (which read the user's file from disk). Volume is applied via a
// master gain node.
import type { SoundPlay, SoundPreset } from "../../shared/protocol";

let ctx: AudioContext | undefined;
function audio(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return ctx;
}

interface Note {
  freq: number;
  start: number;
  dur: number;
  gain: number;
  type: OscillatorType;
}

// Each preset is a short sequence of notes. Kept distinct so they're
// recognizable by ear.
const PRESETS: Record<Exclude<SoundPreset, "custom" | "none">, Note[]> = {
  ping: [
    { freq: 660, start: 0, dur: 0.16, gain: 0.9, type: "triangle" },
    { freq: 990, start: 0.14, dur: 0.22, gain: 1, type: "triangle" },
  ],
  chime: [
    { freq: 560, start: 0, dur: 0.28, gain: 0.7, type: "sine" },
    { freq: 420, start: 0.16, dur: 0.3, gain: 0.6, type: "sine" },
  ],
  blip: [{ freq: 880, start: 0, dur: 0.09, gain: 0.9, type: "square" }],
  marimba: [
    { freq: 523, start: 0, dur: 0.18, gain: 0.8, type: "sine" },
    { freq: 659, start: 0.1, dur: 0.18, gain: 0.7, type: "sine" },
    { freq: 784, start: 0.2, dur: 0.24, gain: 0.7, type: "sine" },
  ],
  knock: [
    { freq: 180, start: 0, dur: 0.12, gain: 1, type: "sine" },
    { freq: 150, start: 0.16, dur: 0.14, gain: 0.9, type: "sine" },
  ],
};

function playSynth(notes: Note[], volume: number) {
  const ac = audio();
  void ac.resume();
  const master = ac.createGain();
  master.gain.value = volume;
  master.connect(ac.destination);
  for (const n of notes) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = n.type;
    osc.frequency.value = n.freq;
    const t0 = ac.currentTime + n.start;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.gain), t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + n.dur + 0.02);
  }
}

function playDataUri(uri: string, volume: number) {
  const el = new Audio(uri);
  el.volume = Math.max(0, Math.min(1, volume));
  void el.play().catch(() => {
    /* autoplay may be blocked until first user gesture; ignore */
  });
}

export function play(p: SoundPlay): void {
  try {
    if (p.preset === "none") return;
    if (p.preset === "custom") {
      if (p.dataUri) playDataUri(p.dataUri, p.volume);
      return;
    }
    playSynth(PRESETS[p.preset], p.volume);
  } catch {
    /* audio unavailable; ignore */
  }
}
