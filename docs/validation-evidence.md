# Validation evidence

Validated: 2026-08-01 (demo-completion-repair-1)

Final verdict: Generator local gate **PASS** (`npm run verify` including `build:sites`).

## Aggregate gate

```bash
npm run typecheck
npm run lint
npm run validate:fhir
npm run test:unit
npm run test:contract
npm run test:replay
npm run test:db
npm run build:next
npm run test:e2e
npm run build:sites
bash /Users/jeonhwichan/.codex/plugins/cache/openai-bundled/sites/0.1.33/skills/sites-hosting/scripts/package-site.sh . /private/tmp/overturn-sites-repair.tar.gz
npm run test:secrets
npm run verify
```

| Gate | Result |
|---|---|
| TypeScript | Passed |
| ESLint | Passed |
| FHIR validation | Passed (3) |
| Unit tests | Passed (32) |
| Contract tests | Passed (27) |
| Replay tests | Passed (3) |
| Database / session / D1 tests | Passed (7) |
| Next.js production build (`build:next`) | Passed |
| Chromium E2E | Passed (15; includes BFF project) |
| vinext Sites build (`build:sites`) | Passed (`dist/server/index.js`) |
| package-site.sh archive | Passed |
| Secret canary | Passed |

## G01-G20 acceptance matrix

| ID | Criterion | Status |
|---|---|---|
| G01 | `build:sites` exits 0 with `dist/server/index.js` + hosting + migrations | Pass |
| G02 | Worker selects real D1 repository via `env.DB` | Pass |
| G03 | Two ActionService instances share one repo → one Allow once effect | Pass |
| G04 | Arbitrary action injection rejected; Claim F submit rejected | Pass |
| G05 | Claim D old→new member ID + original/corrected Claim.related | Pass |
| G06 | Claim B refresh needs no Allow once / no approval.consumed | Pass |
| G07 | Free-text intents classify correctly; proposal-only (except B refresh) | Pass |
| G08 | BFF chat uses strict classifier; visible failure; no synthetic fallback | Pass |
| G09 | Connected verified-paid fails closed on posting mismatches | Pass |
| G10 | Missing reset / corrupt mirror fail closed | Pass |
| G11 | Same-encounter multi-claim does not cross-link evidence | Pass |
| G12 | Chat input labeled; 390px no horizontal overflow; keyboard works | Pass |
| G13 | Live E2E mutates synthetic sessions only; refuses connected healthcare | Implemented (`test:e2e:live`) |
| G14 | Docs honest about Sites readiness | Pass |
| G15 | No secrets/PHI/live payer writes introduced | Pass |
| G16 | Session cookie isolation + per-session reset | Pass |
| G17 | D1 unique reservation concurrency | Pass |
| G18 | Medplum posting amount/control/reference exact match | Pass |
| G19 | package-site.sh accepts archive | Pass |
| G20 | `npm run verify` includes Next + Sites builds | Pass |

## Honest boundary

- Default public path is local healthcare + synthetic agent.
- Sites deployability is evidenced by `build:sites` + `package-site.sh`, not by schema files alone.
- Connected BFF/Medplum remain optional; failure is visible; no silent fallback.
- No claim of live Stedi, live Medplum credentials, or live payer writes.
- `LIVE_BASE_URL=... npm run test:e2e:live` is post-deploy only and was not run against a public URL in this turn.
