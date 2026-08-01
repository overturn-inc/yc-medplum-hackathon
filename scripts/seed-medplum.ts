console.log(
  "seed:medplum requires explicit MEDPLUM_* credentials and is intentionally a no-op without them.",
);
if (!process.env.MEDPLUM_CLIENT_SECRET) {
  console.log("Skipping: no credentials configured.");
  process.exit(0);
}
console.error("Connected Medplum seeding is not enabled in this local-first demo turn.");
process.exit(1);
