export interface VideoState {
  caption: string;
  hostPresent: boolean;
  listening: boolean;
  transcriptionAvailable: boolean;
  level: number;
}

export interface MatrixVideo {
  track: MediaStreamTrack;
  update(change: Partial<VideoState>): void;
  stop(): void;
}

declare global {
  interface Window { shutterVideo: MatrixVideo }
}

/** Serialized into Chromium; drawing assets and fonts have no external dependencies. */
export function installMatrixVideo({ captioning }: { captioning: boolean }): void {
  const palette = {
    background: "#020805", panel: "#041209", border: "#14532b",
    accent: "#32f576", text: "#b6ffcc", muted: "#8dcc9f",
    rain: "#0a4822", head: "#237b3b", warning: "#f5c76a",
  };
  const width = 640;
  const height = 360;
  const font = '"SFMono-Regular", Menlo, Consolas, monospace';
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  canvas.dataset.testid = "agent-video-output";
  canvas.setAttribute("role", "img");
  document.body.style.margin = "0";
  document.body.style.background = palette.background;
  document.body.append(canvas);
  const context = canvas.getContext("2d")!;
  context.scale(2, 2);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let state: VideoState = {
    caption: "", hostPresent: false, listening: false,
    transcriptionAvailable: true, level: 0,
  };
  let lastAudioAt = 0;
  let stopped = false;
  const levels = Array<number>(32).fill(0);
  const glyphs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  const draw = () => {
    if (stopped) return;
    const now = performance.now();
    const tick = reducedMotion ? 0 : Math.floor(now / (1000 / 15));
    const listening = captioning && state.transcriptionAvailable && state.hostPresent &&
      state.listening && now - lastAudioAt < 1_500;
    const status = !captioning ? "VIDEO LIVE" : !state.transcriptionAvailable ? "STT OFFLINE"
      : listening ? "LIVE / LISTENING" : state.hostPresent ? "AUDIO WAIT" : "WAITING FOR HOST";
    const accent = state.transcriptionAvailable ? palette.accent : palette.warning;
    canvas.dataset.status = listening ? "listening" : !state.transcriptionAvailable ? "error"
      : state.hostPresent ? "connecting" : "waiting";
    canvas.setAttribute("aria-label", `${status}. ${state.caption || "No transcript yet."}`);

    context.fillStyle = palette.background;
    context.fillRect(0, 0, width, height);
    context.font = `14px ${font}`;
    for (let column = 0; column < 40; column++) {
      const head = (column * 47 + tick * (1 + column % 3)) % (height + 160) - 80;
      for (let tail = 0; tail < 8; tail++) {
        const y = head - tail * 18;
        context.fillStyle = tail === 0 ? palette.head : palette.rain;
        context.globalAlpha = 1 - tail / 9;
        context.fillText(glyphs[(column * 13 + tail * 7 + Math.floor(tick / 3)) % glyphs.length]!, column * 16, y);
      }
    }
    context.globalAlpha = 1;

    context.fillStyle = palette.background;
    context.fillRect(16, 12, 608, 64);
    context.fillStyle = palette.accent;
    context.font = `bold 22px ${font}`;
    context.fillText("AGENT // 01", 24, 36);
    context.fillStyle = palette.muted;
    context.font = `12px ${font}`;
    context.fillText(captioning ? "PARAKEET EN | LOCAL INFERENCE" : "GENERATED VIDEO UPLINK", 24, 58);
    context.strokeStyle = palette.border;
    context.strokeRect(422.5, 16.5, 193, 36);
    context.fillStyle = accent;
    context.font = `bold 13px ${font}`;
    context.fillText(status, 450, 39);
    // The solid core never blinks off; only its surrounding halo breathes.
    const pulse = reducedMotion ? 0.2 : 0.18 + 0.12 * (1 + Math.sin(now / 600)) / 2;
    context.globalAlpha = listening ? pulse : 0.12;
    context.beginPath();
    context.arc(437, 34, 9, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
    context.beginPath();
    context.arc(437, 34, listening ? 3.5 : 2, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = palette.panel;
    context.fillRect(24, 88, 592, 200);
    context.strokeStyle = palette.border;
    context.strokeRect(24.5, 88.5, 591, 199);
    context.fillStyle = palette.muted;
    context.font = `12px ${font}`;
    context.fillText(captioning ? "> HOST TRANSCRIPT" : "> GENERATED VIDEO", 40, 109);
    context.fillStyle = palette.text;
    context.font = `24px ${font}`;
    const text = state.caption || (!captioning ? "Video uplink active."
      : !state.transcriptionAvailable ? "Local transcription unavailable."
      : listening ? "Audio channel open. Waiting for host speech."
      : state.hostPresent ? "Establishing host audio link..." : "Waiting for the host to connect.");
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/)) {
      if (line && context.measureText(`${line} ${word}`).width > 560) { lines.push(line); line = ""; }
      for (const char of `${line ? " " : ""}${word}`) {
        if (context.measureText(line + char).width > 560) { lines.push(line); line = ""; }
        line += char;
      }
    }
    if (line) lines.push(line);
    for (const [index, text] of lines.slice(-5).entries()) context.fillText(text, 40, 142 + index * 28);

    context.fillStyle = palette.background;
    context.fillRect(16, 300, 608, 48);
    context.fillStyle = accent;
    context.font = `bold 12px ${font}`;
    context.fillText(listening ? "HOST AUDIO // OPEN" : status, 24, 317);
    context.fillStyle = palette.muted;
    context.font = `11px ${font}`;
    context.fillText("MIC OUT // SILENT", 24, 337);
    context.fillText(captioning ? "RX / 16 kHz MONO" : "RX / DISABLED", 420, 337);
    context.fillStyle = listening ? palette.accent : palette.border;
    for (let index = 0; index < levels.length; index++) {
      const bar = listening ? Math.max(1, Math.min(18, levels[index]! * 180)) : 1;
      context.fillRect(422 + index * 6, 316 - bar, 3, bar);
    }
  };

  draw();
  const timer = setInterval(draw, 1000 / 15);
  const track = canvas.captureStream(15).getVideoTracks()[0]!;
  track.contentHint = "detail";
  window.shutterVideo = {
    track,
    update(change) {
      state = { ...state, ...change };
      if (change.listening === false) levels.fill(0);
      if (change.listening) {
        lastAudioAt = performance.now();
        levels.shift();
        levels.push(change.level ?? 0);
      }
      if (change.hostPresent === false) {
        state = { ...state, caption: "", listening: false, level: 0 };
        levels.fill(0);
      }
      draw();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      track.stop();
      canvas.remove();
    },
  };
}
