import { chromium } from "playwright";
import { SyntheticMediaPublisher } from "../dist/synthetic-media.js";

// Only Live signaling is doubled. Both WebRTC endpoints and media decoding are real Chromium.
export async function mediaPeer(t) {
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
  const publisher = new SyntheticMediaPublisher(session, [], (operation, error) => operations.push({ operation, error }));
  t.after(() => publisher.stop());
  return {
    publisher, session, page, operations,
    flush: () => work,
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
          const audioReady = stats.some(row => row.type === "inbound-rtp" && row.kind === "audio" && row.totalAudioEnergy > 0);
          const videoReady = stats.some(row => row.type === "inbound-rtp" && row.kind === "video" && row.framesDecoded >= 5);
          if (audioReady && videoReady) break;
          if (Date.now() > deadline) throw new Error("Timed out waiting for decoded audio/video");
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const stats = [...(await window.receiver.getStats()).values()];
        const audio = stats.find(row => row.type === "inbound-rtp" && row.kind === "audio");
        const video = stats.find(row => row.type === "inbound-rtp" && row.kind === "video");
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d");
        context.drawImage(window.video, 0, 0);
        const first = context.getImageData(0, 0, 640, 360).data;
        await new Promise(resolve => setTimeout(resolve, 400));
        context.drawImage(window.video, 0, 0);
        const second = context.getImageData(0, 0, 640, 360).data;
        return {
          energy: audio.totalAudioEnergy, audioBytes: audio.bytesReceived,
          frames: video.framesDecoded, width: window.video.videoWidth, height: window.video.videoHeight,
          changing: first.some((value, index) => value !== second[index]),
        };
      });
    },
  };
}
