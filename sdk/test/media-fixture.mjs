import { chromium } from "playwright";
import { MediaPublisher } from "../dist/media.js";
import { testSourceScript } from "./test-source.mjs";

// Only Live signaling is doubled. Both WebRTC endpoints and media decoding are real Chromium.
export async function mediaPeer(t, options = {}) {
  const browser = await chromium.launch({
    headless: true, args: ["--autoplay-policy=no-user-gesture-required"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://receiver.invalid/", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><html><body></body></html>",
  }));
  await page.goto("https://receiver.invalid/");
  const listeners = new Set();
  const operations = [];
  let work = Promise.resolve();
  const session = {
    snapshot: { area: "Live", self: { cid: "agent" }, pts: [] },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    publish(type, data) {
      work = work.then(() => page.evaluate(async ({ type, data }) => {
        const pc = window.receiver;
        if (type === "webrtc.p2p.offer") {
          await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
          if (window.inputTrack) {
            const audio = pc.getTransceivers().find(t => t.receiver.track.kind === "audio");
            audio.direction = "sendrecv";
            await audio.sender.replaceTrack(window.inputTrack);
          }
          await pc.setLocalDescription(await pc.createAnswer());
          await window.reply("webrtc.p2p.answer", { sdp: pc.localDescription.sdp });
        } else if (type === "webrtc.p2p.answer") {
          await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        } else if (type === "webrtc.p2p.ice-candidate") {
          await pc.addIceCandidate({ candidate: data.candidate, sdpMid: data.streamId, sdpMLineIndex: data.lineIndex });
        }
      }, { type, data }));
      work.catch(() => {}); // Retain the rejection for flush(), without an unhandled rejection.
    },
  };
  const reply = (type, data) => {
    for (const listener of listeners) listener({ type, participantId: "remote", data });
  };
  await page.exposeFunction("reply", reply);
  await page.evaluate(() => {
    window.receiver = new RTCPeerConnection({ iceServers: [] });
    window.video = document.createElement("video");
    window.video.muted = true;
    window.video.autoplay = true;
    document.body.append(window.video);
    window.receiver.onicecandidate = event => {
      if (event.candidate) void window.reply("webrtc.p2p.ice-candidate", {
        candidate: event.candidate.candidate,
        streamId: event.candidate.sdpMid, lineIndex: event.candidate.sdpMLineIndex,
      });
    };
    window.receiver.ontrack = event => {
      if (event.track.kind === "video") window.video.srcObject = new MediaStream([event.track]);
      if (event.track.kind === "audio") {
        window.audioStream = new MediaStream([event.track]);
        window.audioElement = document.createElement("audio");
        window.audioElement.autoplay = true;
        window.audioElement.srcObject = window.audioStream;
        document.body.append(window.audioElement);
        void window.audioElement.play();
      }
    };
  });
  const publisher = new MediaPublisher(session, [], (operation, error) => operations.push({ operation, error }), {
    sourceScript: testSourceScript,
    videoEncoding: { maxBitrate: 3_000_000, maxFramerate: 15, scaleResolutionDownBy: 1, degradationPreference: "maintain-resolution" },
    ...options,
  });
  session.updateMedia = state => publisher.update(state);
  t.after(() => publisher.stop());
  return {
    publisher, session, page, operations,
    flush: () => work,
    async prepareAudio(samples, sampleRate) {
      await page.evaluate(({ samples, sampleRate }) => {
        window.inputAudio = new AudioContext({ sampleRate });
        window.inputSource = window.inputAudio.createBufferSource();
        const buffer = window.inputAudio.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(Float32Array.from(samples), 0);
        window.inputSource.buffer = buffer;
        const destination = window.inputAudio.createMediaStreamDestination();
        window.inputSource.connect(destination);
        window.inputTrack = destination.stream.getAudioTracks()[0];
      }, { samples: Array.from(samples), sampleRate });
    },
    async playAudio() {
      await page.evaluate(async () => {
        await window.inputAudio.resume();
        window.inputSource.start();
      });
    },
    async captionPixels() {
      return page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d");
        context.drawImage(window.video, 0, 0, 640, 360);
        const pixels = context.getImageData(40, 120, 560, 150).data;
        let bright = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 1] > 180 && pixels[i + 1] > pixels[i] * 1.25 && pixels[i + 1] > pixels[i + 2] * 1.15) bright++;
        }
        return bright;
      });
    },
    async offer() {
      const sdp = await page.evaluate(async () => {
        window.receiver.addTransceiver("audio", { direction: "recvonly" });
        window.receiver.addTransceiver("video", { direction: "recvonly" });
        await window.receiver.setLocalDescription(await window.receiver.createOffer());
        return window.receiver.localDescription.sdp;
      });
      reply("webrtc.p2p.offer", { sdp, connectionId: "remote-connection" });
    },
    async received() {
      return page.evaluate(async () => {
        const deadline = Date.now() + 15_000;
        while (true) {
          const stats = [...(await window.receiver.getStats()).values()];
          const audioReady = stats.some(row => row.type === "inbound-rtp" && row.kind === "audio" && row.bytesReceived > 0);
          const videoReady = stats.some(row => row.type === "inbound-rtp" && row.kind === "video" &&
            row.framesDecoded >= 5 && row.frameWidth === 1280 && row.frameHeight === 720);
          if (audioReady && videoReady) break;
          if (Date.now() > deadline) throw new Error("Timed out waiting for decoded audio/video");
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const stats = [...(await window.receiver.getStats()).values()];
        const audio = stats.find(row => row.type === "inbound-rtp" && row.kind === "audio");
        const video = stats.find(row => row.type === "inbound-rtp" && row.kind === "video");
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const context = canvas.getContext("2d");
        context.drawImage(window.video, 0, 0);
        const first = context.getImageData(0, 0, 1280, 720).data;
        await new Promise(resolve => setTimeout(resolve, 400));
        context.drawImage(window.video, 0, 0);
        const second = context.getImageData(0, 0, 1280, 720).data;
        return {
          energy: audio?.totalAudioEnergy ?? 0, audioBytes: audio?.bytesReceived ?? 0,
          audioRms: Math.sqrt((audio?.totalAudioEnergy ?? 0) / (audio?.totalSamplesDuration || 1)),
          frames: video.framesDecoded, width: window.video.videoWidth, height: window.video.videoHeight,
          changing: first.some((value, index) => value !== second[index]),
        };
      });
    },
  };
}
