// Minimal PCM WAV encoder. No third-party audio dependency is needed for a
// short synthetic tone, and it keeps the sidecar's dependency footprint small.

/**
 * Builds a mono 16-bit PCM WAV buffer containing a single soft sine tone.
 * This is a placeholder for "synthetic payer audio" — a repository-owned
 * asset with no real PHI, spoken words, or recorded voice.
 */
export function buildToneWav({
  durationSeconds = 1.5,
  frequencyHz = 440,
  sampleRateHz = 16000,
  amplitude = 0.15,
} = {}) {
  const sampleCount = Math.round(durationSeconds * sampleRateHz);
  const dataSize = sampleCount * 2; // 16-bit mono
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < sampleCount; i += 1) {
    // Fade the first/last 5% in and out to avoid an audible click.
    const fadeSamples = Math.round(sampleCount * 0.05);
    let envelope = 1;
    if (i < fadeSamples) envelope = i / fadeSamples;
    else if (i > sampleCount - fadeSamples) envelope = (sampleCount - i) / fadeSamples;

    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRateHz) * amplitude * envelope;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }

  return Buffer.concat([header, data]);
}
