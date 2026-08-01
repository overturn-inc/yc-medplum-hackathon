import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";
import { transcribePrerecorded, synthesizeSpeech } from "../voice/deepgram.mjs";
import { extractAllowlistedFacts } from "../voice/facts.mjs";

export const needsBrowser = false;

const here = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_PATH = path.join(here, "..", "..", "assets", "synthetic-payer-denial.wav");

function disclosureFor(mode) {
  return {
    voiceSessionLabel: mode === "live" ? "Live Deepgram voice session" : "Deepgram voice session (mock mode, no live API call)",
    audioSourceLabel: "scripted synthetic payer audio",
    phoneDialed: false,
    phoneDialedLabel: "no phone dialed",
  };
}

export async function run(job, { entry, addProgress, saveAudioProof }) {
  const mode = config.effectiveVoiceMode;

  addProgress("transcribing");
  const audioBuffer = readFileSync(AUDIO_PATH);
  const startedAt = Date.now();

  let sttResult;
  try {
    sttResult = await transcribePrerecorded({ audioBuffer, apiKey: config.deepgramApiKey, mode });
  } catch (error) {
    return {
      state: "failed_safe",
      error: { provider: "deepgram", stage: "stt", message: error.message },
    };
  }

  const facts = extractAllowlistedFacts(sttResult.transcript);
  const inputProof = await saveAudioProof(audioBuffer);

  addProgress("speaking");
  const responseText = facts.status
    ? `Overturn received your claim status update for ${facts.claimReference || entry.claimId}: ${facts.status}` +
      `${facts.reasonCode ? `, reason code ${facts.reasonCode}` : ""}. ${facts.nextStep || ""}`.trim()
    : `Overturn could not confidently extract claim status facts from this audio session.`;

  let ttsResult;
  try {
    ttsResult = await synthesizeSpeech({ text: responseText, apiKey: config.deepgramApiKey, mode });
  } catch (error) {
    return {
      state: "failed_safe",
      error: { provider: "deepgram", stage: "tts", message: error.message },
    };
  }

  const outputProof = await saveAudioProof(ttsResult.audioBuffer);

  addProgress("finalizing");
  return {
    state: "completed",
    result: {
      claimId: entry.claimId,
      disclosure: disclosureFor(mode),
      transcript: sttResult.transcript,
      facts,
      durationSec: sttResult.durationSec,
      elapsedMs: Date.now() - startedAt,
      responseText,
      providers: {
        stt: { modelName: sttResult.modelName, requestId: sttResult.requestId, mode: sttResult.mode },
        tts: { modelName: ttsResult.modelName, requestId: ttsResult.requestId, mode: ttsResult.mode },
      },
      proofIds: [inputProof.proofId, outputProof.proofId],
    },
  };
}
