import * as investigateClaim from "./investigateClaim.mjs";
import * as recheckReprocessing from "./recheckReprocessing.mjs";
import * as submitAppeal from "./submitAppeal.mjs";
import * as voiceSession from "./voiceSession.mjs";

export const ACTION_HANDLERS = Object.freeze({
  investigate_claim: investigateClaim,
  recheck_reprocessing: recheckReprocessing,
  submit_appeal: submitAppeal,
  voice_session: voiceSession,
});
