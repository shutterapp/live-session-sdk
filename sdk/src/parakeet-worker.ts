import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { join } from "node:path";

interface Stream { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void }
interface Recognizer {
  createStream(): Stream;
  decode(stream: Stream): void;
  getResult(stream: Stream): { text: string };
}

// The optional native STT runtime is loaded only inside this inference worker.
try {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as {
    OfflineRecognizer: new (config: unknown) => Recognizer;
  };
  const { modelDirectory, numThreads } = workerData as { modelDirectory: string; numThreads: number };
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(modelDirectory, "encoder.int8.onnx"),
        decoder: join(modelDirectory, "decoder.int8.onnx"),
        joiner: join(modelDirectory, "joiner.int8.onnx"),
      },
      tokens: join(modelDirectory, "tokens.txt"),
      modelType: "nemo_transducer", numThreads, provider: "cpu", debug: false,
    },
    decodingMethod: "greedy_search",
  });
  parentPort!.on("message", ({ id, samples }: { id: number; samples: Float32Array }) => {
    try {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16_000, samples });
      recognizer.decode(stream);
      parentPort!.postMessage({ type: "result", id, text: recognizer.getResult(stream).text.trim() });
    } catch {
      parentPort!.postMessage({ type: "error" });
    }
  });
  parentPort!.postMessage({ type: "ready" });
} catch {
  parentPort!.postMessage({ type: "error" });
}
