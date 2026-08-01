import express from "express";
import { NORTHSTAR_PORTAL_PASSWORD, NORTHSTAR_PORTAL_USERNAME } from "../allowlist.mjs";
import { computeConfirmationNumber } from "../confirmation.mjs";
import {
  createSession,
  getClaim,
  isValidSession,
  markReprocessingRechecked,
  submitAppeal,
} from "./state.mjs";
import {
  appealFormPage,
  appealResultPage,
  claimDetailPage,
  claimLookupPage,
  loginPage,
  recheckResultPage,
} from "./views.mjs";

const SESSION_COOKIE = "northstar_session";

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function requireLogin(request, response, next) {
  const cookies = parseCookies(request.headers.cookie);
  if (!isValidSession(cookies[SESSION_COOKIE])) {
    response.redirect("/portal/login");
    return;
  }
  next();
}

export function createPortalRouter() {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.get("/login", (request, response) => {
    response.type("html").send(loginPage());
  });

  router.post("/login", (request, response) => {
    const { username, password } = request.body || {};
    if (username !== NORTHSTAR_PORTAL_USERNAME || password !== NORTHSTAR_PORTAL_PASSWORD) {
      response.status(401).type("html").send(loginPage({ error: "Invalid demo credentials." }));
      return;
    }
    const token = createSession(username);
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/portal; SameSite=Lax`,
    );
    response.redirect("/portal/claims");
  });

  router.get("/claims", requireLogin, (request, response) => {
    response.type("html").send(claimLookupPage());
  });

  router.post("/claims/search", requireLogin, (request, response) => {
    const claimId = String(request.body?.claimId || "").trim();
    const claim = getClaim(claimId);
    if (!claim) {
      response.status(404).type("html").send(claimLookupPage({ notFound: true }));
      return;
    }
    response.redirect(`/portal/claims/${encodeURIComponent(claimId)}`);
  });

  router.get("/claims/:claimId", requireLogin, (request, response) => {
    const claim = getClaim(request.params.claimId);
    if (!claim) {
      response.status(404).type("html").send(claimLookupPage({ notFound: true }));
      return;
    }
    response.type("html").send(claimDetailPage(claim));
  });

  router.get("/claims/:claimId/recheck", requireLogin, (request, response) => {
    const claim = getClaim(request.params.claimId);
    if (!claim) {
      response.status(404).type("html").send(claimLookupPage({ notFound: true }));
      return;
    }
    const updated = markReprocessingRechecked(claim.claimId);
    response.type("html").send(recheckResultPage(updated));
  });

  router.get("/claims/:claimId/appeal", requireLogin, (request, response) => {
    const claim = getClaim(request.params.claimId);
    if (!claim) {
      response.status(404).type("html").send(claimLookupPage({ notFound: true }));
      return;
    }
    const idempotencyKey = String(request.query.idempotencyKey || "");
    response.type("html").send(appealFormPage(claim, idempotencyKey));
  });

  router.post("/claims/:claimId/appeal", requireLogin, (request, response) => {
    const claim = getClaim(request.params.claimId);
    if (!claim) {
      response.status(404).type("html").send(claimLookupPage({ notFound: true }));
      return;
    }
    const idempotencyKey = String(request.body?.idempotencyKey || "");
    const wasAlreadySubmitted = claim.appeal.submitted;
    const confirmationNumber = wasAlreadySubmitted
      ? claim.appeal.confirmationNumber
      : computeConfirmationNumber(claim.claimId, idempotencyKey);
    submitAppeal(claim.claimId, idempotencyKey, confirmationNumber);
    const refreshed = getClaim(claim.claimId);
    response
      .type("html")
      .send(appealResultPage(refreshed, { isFreshSubmission: !wasAlreadySubmitted }));
  });

  return router;
}
