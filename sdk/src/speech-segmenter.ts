/** Energy endpoints for mono 16 kHz audio; all buffers are bounded by eight seconds. */
export class SpeechSegmenter {
  #frames: Float32Array[] = [];
  #previous = new Float32Array(0);
  #samples = 0;
  #voiced = 0;
  #silence = 0;
  #emit: (samples: Float32Array) => void;

  constructor(emit: (samples: Float32Array) => void) { this.#emit = emit; }

  accept(samples: Float32Array): void {
    const energy = samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
    const speech = energy >= 0.006 ** 2;
    if (!this.#frames.length && !speech) {
      this.#previous = samples.slice();
      return;
    }
    if (!this.#frames.length && this.#previous.length) {
      this.#frames.push(this.#previous);
      this.#samples += this.#previous.length;
    }
    this.#frames.push(samples.slice());
    this.#samples += samples.length;
    this.#voiced += speech ? samples.length : 0;
    this.#silence = speech ? 0 : this.#silence + samples.length;
    if (this.#silence >= 9_600 || this.#samples >= 128_000) this.flush();
  }

  flush(): void {
    if (this.#voiced >= 3_200) {
      const utterance = new Float32Array(this.#samples);
      let offset = 0;
      for (const frame of this.#frames) { utterance.set(frame, offset); offset += frame.length; }
      this.#emit(utterance);
    }
    this.reset();
  }

  reset(): void {
    this.#frames = [];
    this.#previous = new Float32Array(0);
    this.#samples = this.#voiced = this.#silence = 0;
  }
}
