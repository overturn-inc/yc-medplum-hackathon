#!/usr/bin/env node
// One-time (or on-demand) generator for the repository-owned synthetic payer
// audio asset. Run with: npm run generate:audio
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildToneWav } from "../src/wav.mjs";
import { SCRIPTED_TRANSCRIPT, synthesizeSpeech } from "../src/voice/deepgram.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, "..", "assets", "synthetic-payer-denial.wav");

const apiKey = process.env.DEEPGRAM_API_KEY;
const wav = apiKey
  ? (
      await synthesizeSpeech({
        text: SCRIPTED_TRANSCRIPT,
        apiKey,
        mode: "live",
      })
    ).audioBuffer
  : buildToneWav({ durationSeconds: 2, frequencyHz: 440 });
writeFileSync(outPath, wav);
console.log(
  `Wrote ${apiKey ? "Deepgram synthetic speech" : "synthetic tone fallback"} WAV (${wav.length} bytes) to ${outPath}`,
);
