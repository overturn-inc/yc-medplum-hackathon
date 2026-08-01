import { randomUUID } from "node:crypto";
import { buildToneWav } from "../wav.mjs";

// This scripted transcript is what a mock STT pass returns. It is designed
// so that extractAllowlistedFacts() finds every allowlisted field, and it
// contains no real PHI: it describes the same fixed synthetic claim used by
// the browser actions.
export const SCRIPTED_TRANSCRIPT =
  "Thank you for calling Northstar Payer Services. Your claim CLM-EA-1001 was denied. " +
  "The reason code is CO-197, authorization required. Please resubmit with the authorization on file within 30 calendar days.";

const DEEPGRAM_STT_URL = "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true";
const DEEPGRAM_TTS_URL =
  "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&container=wav&sample_rate=24000";
const REQUEST_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs Deepgram prerecorded STT over the synthetic payer audio.
 * Returns { transcript, requestId, modelName, durationSec, mode }.
 * Throws a descriptive (secret-free) error on any provider failure.
 */
export async function transcribePrerecorded({ audioBuffer, apiKey, mode }) {
  if (mode === "mock" || !apiKey) {
    return {
      transcript: SCRIPTED_TRANSCRIPT,
      requestId: `mock-stt-${randomUUID()}`,
      modelName: "mock-scripted-transcript",
      durationSec: 2,
      mode: "mock",
    };
  }

  let response;
  try {
    response = await fetchWithTimeout(DEEPGRAM_STT_URL, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/wav",
      },
      body: audioBuffer,
    });
  } catch (error) {
    throw new Error(`deepgram_stt_request_failed: ${error.name === "AbortError" ? "timeout" : "network_error"}`);
  }

  if (!response.ok) {
    throw new Error(`deepgram_stt_provider_error: status_${response.status}`);
  }

  const payload = await response.json();
  const transcript =
    payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

  return {
    transcript,
    requestId: payload?.metadata?.request_id || response.headers.get("dg-request-id") || null,
    modelName: payload?.metadata?.models?.[0] || "nova-2",
    durationSec: payload?.metadata?.duration ?? null,
    mode: "live",
  };
}

/**
 * Runs Deepgram Aura TTS for the Overturn synthetic response text.
 * Returns { audioBuffer, requestId, modelName, mode }.
 */
export async function synthesizeSpeech({ text, apiKey, mode }) {
  if (mode === "mock" || !apiKey) {
    return {
      audioBuffer: buildToneWav({ durationSeconds: 1, frequencyHz: 660 }),
      requestId: `mock-tts-${randomUUID()}`,
      modelName: "mock-scripted-audio",
      mode: "mock",
    };
  }

  let response;
  try {
    response = await fetchWithTimeout(DEEPGRAM_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
  } catch (error) {
    throw new Error(`deepgram_tts_request_failed: ${error.name === "AbortError" ? "timeout" : "network_error"}`);
  }

  if (!response.ok) {
    throw new Error(`deepgram_tts_provider_error: status_${response.status}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  return {
    audioBuffer,
    requestId: response.headers.get("dg-request-id") || null,
    modelName: "aura-asteria-en",
    mode: "live",
  };
}
