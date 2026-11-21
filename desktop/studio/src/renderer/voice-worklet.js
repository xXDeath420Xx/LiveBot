/*
 * AudioWorklet for voice commands: the AudioContext runs at 16 kHz, so frames arrive already resampled. Converts them
 * to 16-bit PCM in 32 ms chunks (0.2.12; was 100 ms, which added up to 100 ms before a command could run) and reports a level for the "listening" meter. Runs in the hidden audio window only.
 */
class CertiFriedPcm16 extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buf = new Int16Array(512);
        this.n = 0;
        this.sum = 0;
    }

    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        for (let i = 0; i < ch.length; i++) {
            const s = Math.max(-1, Math.min(1, ch[i]));
            this.sum += s * s;
            this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
            if (this.n === this.buf.length) {
                const level = Math.sqrt(this.sum / this.buf.length);
                this.port.postMessage({ pcm: this.buf.buffer, level }, [this.buf.buffer]);
                this.buf = new Int16Array(512);
                this.n = 0;
                this.sum = 0;
            }
        }
        return true;
    }
}

registerProcessor('certifried-pcm16', CertiFriedPcm16);
