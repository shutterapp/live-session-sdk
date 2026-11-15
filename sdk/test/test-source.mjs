// Browser test source for transport tests; no example application code is imported.
async function createTestSource() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  let state = {};
  let frame = 0;
  const draw = () => {
    context.fillStyle = "#000000";
    context.fillRect(0, 0, 1280, 720);
    context.fillStyle = "#ffffff";
    context.fillRect(frame++ % 1240, 650, 40, 40);
    context.font = "48px monospace";
    context.fillText(String(state.caption ?? ""), 80, 300, 1120);
  };
  draw();
  const timer = setInterval(draw, 1000 / 15);
  const videoTrack = canvas.captureStream(15).getVideoTracks()[0];
  videoTrack.contentHint = "detail";
  const audio = new AudioContext({ sampleRate: 48000 });
  const silence = audio.createConstantSource();
  silence.offset.value = 0;
  const destination = audio.createMediaStreamDestination();
  silence.connect(destination);
  silence.start();
  await audio.resume();
  const stream = new MediaStream([destination.stream.getAudioTracks()[0], videoTrack]);
  return {
    stream,
    update(change) { state = { ...state, ...change }; draw(); },
    async stop() {
      clearInterval(timer);
      silence.stop();
      for (const track of stream.getTracks()) track.stop();
      await audio.close();
    },
  };
}

export const testSourceScript = `window.shutterMediaSource = (${createTestSource.toString()})();`;
