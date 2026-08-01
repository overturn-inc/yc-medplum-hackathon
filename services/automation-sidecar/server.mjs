import express from "express";
import { config } from "./src/config.mjs";
import { ensureProofDir, startProofSweeper } from "./src/proof.mjs";
import { createJobsRouter } from "./src/jobsRouter.mjs";
import { createPortalRouter } from "./src/portal/router.mjs";
import { closeBrowser } from "./src/browser.mjs";

ensureProofDir();
startProofSweeper();

const app = express();
app.disable("x-powered-by");

app.get("/health", (request, response) => {
  response.status(200).json({ status: "live" });
});

app.get("/health/ready", (request, response) => {
  response.status(200).json({ status: "ready" });
});

app.use("/portal", createPortalRouter());
app.use("/v1", createJobsRouter());

// Malformed JSON and any other body-parser failure become a clean 400
// instead of Express's default HTML error page.
app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(400).json({ error: "invalid_request" });
});

app.use((request, response) => {
  response.status(404).json({ error: "not_found" });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      event: "automation_sidecar_listening",
      port: config.port,
      voiceMode: config.effectiveVoiceMode,
    }),
  );
});

server.requestTimeout = config.jobTimeoutMs + 15_000;
server.headersTimeout = 20_000;

async function shutdown() {
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
