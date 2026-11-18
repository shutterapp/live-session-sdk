import type { JsonObject } from "@shutter-studio/live-session-sdk";

const promptLines = ["Say:", "- 'start recording'", "- 'stop recording'", "- 'finish session'"];

export function producerVideo() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  document.body.append(canvas);
  const ctx = canvas.getContext("2d")!;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const blue = "#197bb8";
  let caption = "", speaker = "", speakingUntil = 0, available = true;
  let outgoing: MediaStreamAudioSourceNode | undefined, meter: AnalyserNode | undefined;
  const samples = new Float32Array(1024);
  let voice = 0;
  function draw() {
    const now = performance.now();
    const speaking = available && now < speakingUntil;
    const status = !available ? "Transcription offline" : speaking ? "Speaking" : "Listening";
    canvas.setAttribute("aria-label", [promptLines.join("\n"), status, speaker, caption].filter(Boolean).join("\n"));
    ctx.fillStyle = blue;
    ctx.fillRect(0, 0, 1280, 720);
    let rms = 0;
    if (meter) {
      meter.getFloatTimeDomainData(samples);
      for (const sample of samples) rms += sample * sample;
      rms = Math.sqrt(rms / samples.length);
    }
    const target = Math.min(1, Math.max(0, rms - .005) * 9);
    voice += (target - voice) * (target > voice ? .65 : .28);
    const motion = reducedMotion.matches ? 0 : voice;
    const phase = reducedMotion.matches ? 0 : 2 * Math.PI * now / 2600;
    const radius = 58 + (reducedMotion.matches ? 0 : 1.8 * Math.sin(2 * Math.PI * now / 2200)) + 11 * motion;
    const wave = (amplitude: number, offset: number, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const [start, end] of [[0, 640 - radius], [640 + radius, 1280]] as const) {
        for (let x = start; x < end; x += 3) {
          const envelope = Math.min(1, Math.max(0, Math.abs(x - 640) - radius) / 96);
          const y = 360 + envelope * amplitude * Math.sin(x / 47 + phase + offset) * (.72 + .28 * Math.cos(x / 105));
          if (x === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        if (start === 0) ctx.lineTo(end, 360);
      }
      ctx.stroke();
    };
    wave(3 + motion * 12, 1.8, "#7bbad9", 2);
    wave(5 + motion * 22, 0, "#e5f4fb", 3);
    ctx.beginPath();
    ctx.arc(640, 360, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = "#a5d6ea";
    ctx.lineWidth = 2;
    ctx.stroke();
    for (const offset of [0, .5]) {
      const ripple = (phase / (2 * Math.PI) + offset) % 1;
      ctx.beginPath();
      ctx.arc(640, 360, radius + 46 * ripple, 0, 2 * Math.PI);
      ctx.strokeStyle = `rgba(186, 222, 244, ${.38 * (1 - ripple)})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(640, 360, 42, 0, 2 * Math.PI);
    ctx.arc(640, 360, 12, 0, 2 * Math.PI, true);
    ctx.fillStyle = "#fff";
    ctx.fill("evenodd");

    ctx.textAlign = "left";
    const textLeft = 84;
    ctx.font = "600 48px system-ui, sans-serif";
    promptLines.forEach((line, i) => ctx.fillText(line, textLeft, 66 + i * 54));
    if (caption) {
      const width = 1112;
      ctx.font = "400 21px Arial, sans-serif";
      const nameWidth = Math.min(ctx.measureText(speaker).width, 280);
      ctx.fillStyle = "#d4ecf7";
      ctx.fillText(speaker, textLeft, 475, 280);

      ctx.font = "400 32px system-ui, sans-serif";
      ctx.fillStyle = "#fff";
      let inset = nameWidth + 12, y = 475, line = "";
      for (const word of caption.trim().split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > width - inset) {
          if (y === 595) {
            line += "…";
            break;
          }
          ctx.fillText(line, textLeft + inset, y, width - inset);
          inset = 0;
          y += 40;
          line = word;
        } else line = next;
      }
      ctx.fillText(line, textLeft + inset, y, width - inset);
    }
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText(`•  ${status}`, 886, 665);
    ctx.fillText("CS Producer", 14, 705);
  }
  draw();
  const track = canvas.captureStream(15).getVideoTracks()[0]!;
  const timer = setInterval(draw, 1000 / 15);
  return {
    track,
    observeOutgoingAudio(audio: AudioContext, stream: MediaStream) {
      outgoing = audio.createMediaStreamSource(stream);
      meter = audio.createAnalyser();
      meter.fftSize = samples.length;
      outgoing.connect(meter);
    },
    update(change: JsonObject) {
      if (typeof change.transcriptionAvailable === "boolean") available = change.transcriptionAvailable;
      if (typeof change.caption === "string" && change.caption.trim()) {
        caption = change.caption;
        speaker = typeof change.speaker === "string" ? change.speaker : "Guest";
        speakingUntil = performance.now() + Math.min(5500, Math.max(1600, caption.length * 65));
      }
    },
    stop() { clearInterval(timer); outgoing?.disconnect(); meter?.disconnect(); track.stop(); canvas.remove(); },
  };
}
