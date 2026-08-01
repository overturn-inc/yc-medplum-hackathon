const BRAND = "Northstar Payer Services Demo";

const STYLE = `
  :root { color-scheme: light; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #f2f5f9; color: #17233d; }
  header { background: #0b3d91; color: #fff; padding: 16px 24px; }
  header .brand { font-weight: 700; font-size: 18px; }
  header .tag { font-size: 12px; opacity: 0.85; margin-top: 2px; }
  main { max-width: 640px; margin: 32px auto; background: #fff; border-radius: 8px; padding: 24px 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 20px; margin-top: 0; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
  input { width: 100%; padding: 8px 10px; border: 1px solid #c6ccd6; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
  button { margin-top: 18px; padding: 10px 18px; border: none; border-radius: 6px; background: #0b3d91; color: #fff; font-size: 14px; cursor: pointer; }
  .field { margin-bottom: 4px; }
  .field-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #5a6478; }
  .field-value { font-size: 15px; font-weight: 600; margin-bottom: 14px; }
  .banner-denied { background: #fdecec; color: #8a1f1f; border: 1px solid #f3c1c1; border-radius: 6px; padding: 10px 14px; margin: 12px 0; }
  .banner-upheld { background: #fdf3e3; color: #7a5100; border: 1px solid #f2dba6; border-radius: 6px; padding: 10px 14px; margin: 12px 0; }
  .banner-confirmed { background: #e8f6ec; color: #1c6b34; border: 1px solid #b7e3c4; border-radius: 6px; padding: 10px 14px; margin: 12px 0; }
  .synthetic-badge { display: inline-block; font-size: 11px; background: #eef1f6; color: #4a5468; border-radius: 4px; padding: 2px 6px; margin-bottom: 12px; }
  a.link-button { display: inline-block; margin-top: 12px; margin-right: 8px; padding: 8px 14px; border-radius: 6px; background: #eef1f6; color: #0b3d91; text-decoration: none; font-size: 13px; font-weight: 600; }
`;

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title} — ${BRAND}</title>
  <style>${STYLE}</style>
</head>
<body>
  <header>
    <div class="brand">${BRAND}</div>
    <div class="tag">Fictional demo payer portal — synthetic data only, no real claims</div>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

export function loginPage({ error } = {}) {
  return layout(
    "Provider login",
    `
    <span class="synthetic-badge">Synthetic demo credentials</span>
    <h1>Provider login</h1>
    ${error ? `<div class="banner-denied">${error}</div>` : ""}
    <form method="post" action="/portal/login">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="off" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="off" />
      <button type="submit">Sign in</button>
    </form>
    `,
  );
}

export function claimLookupPage({ notFound } = {}) {
  return layout(
    "Claim lookup",
    `
    <span class="synthetic-badge">Synthetic claims only</span>
    <h1>Claim lookup</h1>
    ${notFound ? `<div class="banner-denied">Claim not found in the demo payer system.</div>` : ""}
    <form method="post" action="/portal/claims/search">
      <label for="claimId">Claim ID</label>
      <input id="claimId" name="claimId" type="text" autocomplete="off" />
      <button type="submit">Search</button>
    </form>
    `,
  );
}

export function claimDetailPage(claim) {
  return layout(
    "Claim detail",
    `
    <span class="synthetic-badge">Synthetic claim</span>
    <h1>Claim ${claim.claimId}</h1>
    <div class="field"><div class="field-label">Patient</div><div class="field-value">${claim.patientLabel}</div></div>
    <div class="banner-denied">
      Denial reason: <strong>${claim.denialReasonText}</strong> (code ${claim.denialReasonCode})
    </div>
    <div class="field"><div class="field-label">Authorization on file</div><div class="field-value">${claim.onFileAuthNumber}</div></div>
    <p style="font-size:13px;color:#5a6478;">Northstar's denial reason conflicts with the authorization number already on file for this claim.</p>
    <a class="link-button" href="/portal/claims/${claim.claimId}/recheck">Recheck reprocessing</a>
    <a class="link-button" href="/portal/claims/${claim.claimId}/appeal">Submit appeal</a>
    `,
  );
}

export function recheckResultPage(claim) {
  return layout(
    "Reprocessing recheck",
    `
    <span class="synthetic-badge">Synthetic claim</span>
    <h1>Reprocessing recheck — ${claim.claimId}</h1>
    <div class="banner-upheld">Denial upheld</div>
    <p style="font-size:13px;color:#5a6478;">Northstar has reviewed the reprocessing request and upheld the original denial (${claim.denialReasonText}, code ${claim.denialReasonCode}).</p>
    <a class="link-button" href="/portal/claims/${claim.claimId}">Back to claim</a>
    `,
  );
}

export function appealFormPage(claim, idempotencyKey) {
  return layout(
    "Submit appeal",
    `
    <span class="synthetic-badge">Synthetic claim</span>
    <h1>Submit appeal — ${claim.claimId}</h1>
    <div class="field"><div class="field-label">Denial reason</div><div class="field-value">${claim.denialReasonText} (${claim.denialReasonCode})</div></div>
    <div class="field"><div class="field-label">Authorization on file</div><div class="field-value">${claim.onFileAuthNumber}</div></div>
    <form method="post" action="/portal/claims/${claim.claimId}/appeal">
      <input type="hidden" name="idempotencyKey" value="${idempotencyKey}" />
      <label for="appealReason">Appeal basis</label>
      <input id="appealReason" name="appealReason" type="text" value="Authorization on file at time of service" readonly />
      <button type="submit">Submit appeal</button>
    </form>
    `,
  );
}

export function appealResultPage(claim, { isFreshSubmission }) {
  const heading = isFreshSubmission ? "Appeal submitted" : "Appeal already on file";
  const bannerClass = isFreshSubmission ? "banner-confirmed" : "banner-upheld";
  const bannerText = isFreshSubmission
    ? `Confirmation number: <strong id="confirmationNumber">${claim.appeal.confirmationNumber}</strong>`
    : `An appeal is already on file for this claim. Confirmation number: <strong id="confirmationNumber">${claim.appeal.confirmationNumber}</strong>`;
  return layout(
    "Appeal result",
    `
    <span class="synthetic-badge">Synthetic claim</span>
    <h1>${heading} — ${claim.claimId}</h1>
    <div class="${bannerClass}">${bannerText}</div>
    <a class="link-button" href="/portal/claims/${claim.claimId}">Back to claim</a>
    `,
  );
}
