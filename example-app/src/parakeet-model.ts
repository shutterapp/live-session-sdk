import { ensureModelFiles, type ModelDownloadOptions } from "./model-download.js";

const source = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/84b478d541cdbf0c296a7ab5f1e20a6f8f998114";
const files = [
  { name: "encoder.int8.onnx", size: 652282309, sha256: "92a10bd9c23936ea0566c29f963bc57c2a5df4261b6a8921c39abea66557ca8b" },
  { name: "decoder.int8.onnx", size: 7257753, sha256: "4d097bae3bac5c96018d5293ba39f1b657296102b142affda40378f38b020f41" },
  { name: "joiner.int8.onnx", size: 1739080, sha256: "77a29f3e5ac7d37074e0af465391b80f314015d5b97f0f90c6c7767f1d56f428" },
  { name: "tokens.txt", size: 9384, sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d" },
].map(file => ({ ...file, url: `${source}/${file.name}` }));

/** Explicit first-run provisioning; the recognizer itself never downloads model files. */
export async function ensureParakeetModel(directory: string, options: ModelDownloadOptions = {}): Promise<void> {
  try {
    await ensureModelFiles(directory, files, options);
  } catch {
    if (options.signal?.aborted) throw new Error("Parakeet model download cancelled");
    throw new Error("Unable to prepare Parakeet model; check network access, free disk space and directory permissions");
  }
}
