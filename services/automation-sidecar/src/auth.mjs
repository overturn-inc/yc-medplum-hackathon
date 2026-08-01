import { timingSafeEqual } from "node:crypto";
import { config } from "./config.mjs";

function isAuthorized(header) {
  const supplied = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : "";
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(config.apiKey);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

/** Express middleware enforcing Bearer auth on private job-control routes. */
export function requireBearerAuth(request, response, next) {
  if (!isAuthorized(request.headers.authorization)) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
