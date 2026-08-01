# Overturn Agentic Claims UI functional specification

Status: Design-agent handoff

Target: Claude Design, Opus 5, High effort

Product URL: https://overturn-agentic-claims.argentum1450.chatgpt.site

## 1. Product definition

Overturn is an agent-native medical billing workspace for a practice biller or
operations specialist. It follows a claim from a completed visit through claim
creation, clearinghouse transport, payer adjudication, remittance, and PMS
posting. The product detects conflicting source states, explains the evidence,
drafts the next action, and requires a one-time human approval before any
synthetic external write.

This design is a hackathon demo with synthetic data. It must look credible and
operational without implying that it is a production PMS, a live payer portal,
or a live Medplum deployment.

## 2. Demo story the interface must make obvious

1. A biller opens the practice dashboard and sees visits, claim throughput,
   approvals, and exceptions.
2. A completed encounter is ready for claim creation. A preflight proves that
   encounter, note, coverage, provider, diagnosis, service line, and charge are
   ready.
3. A claim can be submitted only after reviewing a proposal and choosing
   `Allow once`. Creating a proposal alone must never look like submission.
4. The central case is a discrepancy: PMS says processing, but the newer payer
   observation says denied for authorization. Existing evidence says
   authorization was not required for the service date and CPT code.
5. The agent answers questions with claim-scoped evidence, drafts a payer
   reprocessing request, and waits for human approval.
6. `Deny` records only the decision. It produces no artifact, receipt, or
   follow-up.
7. `Allow once` creates a synthetic message artifact, execution receipt, audit
   event, and next follow-up. The claim remains denied or pending reprocessing;
   it must not look paid.
8. A separate claim is `Verified paid` only when remittance and independent PMS
   posting evidence agree.

## 3. Non-negotiable product truths

- Always show `Synthetic data`, `Healthcare: local`, `Agent: bff`, and
  `No live payer writes` in the global shell.
- BFF is live for conversational classification. Claim facts, citations,
  proposals, approval policy, and synthetic domain receipts remain server-owned.
- No real PHI appears anywhere.
- Never collapse encounter, transport, adjudication, remittance, posting, and
  resolution into one misleading status.
- `Submitted`, `Accepted`, `Reprocessing requested`, and `Payer reported paid`
  are not `Verified paid`.
- Read and compare actions do not require approval. Claim submission,
  correction, payer messages, documentation sends, appeals, and posting do.
- A model completion is not proof of a healthcare write. A domain receipt is.

## 4. Users and jobs

Primary user: practice biller or revenue-cycle operations staff.

Primary jobs:

- Find the claims that need attention now.
- Distinguish clearinghouse rejection, payer denial, status delay, information
  request, and verified payment.
- Understand which source reported which state and when.
- Ask the agent for status, reason, evidence, or next action.
- Review an exact proposal and artifact before approving.
- Confirm what changed after an action and when to follow up next.

## 5. Design principles

### Operational hierarchy

Every page should answer, in this order:

1. What needs attention?
2. Why?
3. What evidence supports it?
4. What is the next action?
5. Does it require approval?
6. What happened after execution?

### Visual language

- Desktop-first enterprise healthcare operations UI, optimized for 1440px and
  fully usable at 1280px.
- Calm, trustworthy, high-density, and contemporary. Avoid consumer wellness
  aesthetics, excessive gradients, glassmorphism, huge cards, and decorative
  illustrations.
- Use a restrained deep-teal or ink navigation foundation, warm neutral canvas,
  white work surfaces, and semantic amber, red, blue, and green statuses.
- Typography should favor legibility and tabular scanning. Use a modern sans
  serif for interface copy and a monospace face only for identifiers, code,
  receipts, and evidence references.
- Use icons only when they improve recognition. Every icon-only control needs a
  tooltip and accessible label.
- Human-readable status labels are primary. Raw enum values and proposal
  fingerprints belong in a secondary audit disclosure.

### Density and progressive disclosure

- Make the first viewport useful. Avoid large empty regions or a page composed
  entirely of equally weighted cards.
- Keep operational columns visible; move secondary metadata into row expansion,
  a drawer, or a detail panel.
- Long evidence text and artifact previews need collapsible or scroll-bounded
  containers with copy controls.
- The agent may be visually prominent but must not obscure claim evidence or
  turn the product into a generic chatbot.

## 6. Global application shell

### Left navigation

Enabled routes:

- Overview
- Encounters
- Claims

Visible but disabled, labeled `Coming soon` on hover or focus:

- Work Queue
- Payments
- Agent Activity
- Approvals
- Reports
- Integrations

Requirements:

- Current route is unmistakable.
- Desktop navigation is fixed or sticky and never competes with the page body.
- At 390px, use a compact top bar plus an accessible navigation drawer.
- Brand can read `Harborview PMS` with a smaller `Powered by Overturn` or
  `Agent-native billing workspace` line.

### Global top bar

- Four mode badges remain visible without dominating the page.
- `Reset demo` is a secondary action with a confirmation affordance or clear
  explanation that only the current synthetic session resets.
- Include an unobtrusive demo status indicator rather than presenting mode
  badges as interchangeable data chips.

## 7. Page: Overview `/dashboard`

### Goal

Give an operator a prioritized daily command center, not a generic analytics
dashboard.

### Required content

KPI:

- Visits today
- Visits this month
- Ready to submit
- Submitted or in flight
- Awaiting payer
- Needs attention
- Verified paid MTD

Mutually exclusive claim funnel:

- Needs claim
- Ready to submit
- Rejected before adjudication
- Awaiting payer
- Action required
- Denied under resolution
- Paid needs posting
- Reconciled or closed

Overlapping flags:

- Follow-up due
- Source discrepancy
- Approval required

Queues:

- Agent approvals
- Exceptions and follow-up

### Interaction requirements

- Every KPI and funnel item navigates to the corresponding filtered claim or
  encounter view.
- Every queue item opens the correct episode workbench.
- Queue rows show patient, concise issue, urgency or age, and the proposed next
  action. Avoid repeating the same sentence twice.
- Approval and exception queues must be visually distinguishable.
- Zero states should remain informative and compact.

### Preferred composition

- Compact KPI strip at the top.
- Main two-column operational area: prioritized work queue as the larger region,
  claim funnel and health summary as the smaller region.
- Make `Needs attention`, `Approval required`, and `Source discrepancy` more
  actionable than passive visit totals.
- The current implementation's long vertical funnel can be replaced with a
  compact stacked bar, stepped pipeline, or dense labeled counts, provided exact
  counts and click targets remain clear.

## 8. Page: Encounters `/encounters`

### Goal

Review completed encounters, identify billing readiness, and submit a ready
claim through preflight and one-time approval.

### Queue requirements

Filters:

- All
- Ready to bill
- Missing information
- Claim created

Core columns:

- Patient
- Date of service
- Provider
- Coverage
- Note
- Coding
- Charge
- Billing state

Encounter state may appear as supporting metadata rather than consuming a full
column when it is redundant.

### Selected encounter and preflight

Selecting the ready encounter opens a master-detail work area. It must show:

- Patient, payer, provider, service date, CPT or service line, and charge
- Completed encounter
- Final signed note
- Active coverage
- Provider
- Diagnosis
- Service line
- Charge readiness
- Claim submission proposal
- Exact `Deny` and `Allow once` actions
- Post-action clearinghouse receipt without implying payer adjudication

### Preferred composition

- Use a master-detail layout or detail drawer so the queue remains visible.
- Summarize the lifecycle before exposing raw source blocks.
- Preflight checks should scan as a concise checklist with clear pass or block
  semantics.
- The agent panel should answer readiness questions and create a proposal, but
  approval controls remain visually distinct from chat.

## 9. Page: Claims `/claims`

### Goal

Scan the entire claim lifecycle and open the highest-value exception quickly.

### Filters

- Draft
- Submitted
- Rejected
- Accepted
- Processing
- Pended
- Denied
- Paid
- Needs attention
- Needs claim
- Ready to submit
- Rejected queue
- Awaiting payer
- Action required
- Denial resolution
- Needs posting
- Reconciled
- Discrepancy
- Needs approval
- Follow-up due

Do not render all filters as an uncontrolled multi-line wall of pills. Use a
small primary segmented control plus a `More filters` popover or grouped filter
drawer. Preserve deep-link filtering through the existing query parameter.

### Priority table columns

Always visible at desktop widths:

- Patient and claim ID
- Date of service
- Payer
- Billed amount
- Human-readable primary status
- Issue or discrepancy
- Next action or agent recommendation
- Next follow-up or age
- Owner

Secondary data available through row expansion or column settings:

- CPT
- PMS state
- Clearinghouse state
- Payer state
- Remittance and posting state
- Last payer check

### Interaction requirements

- Entire row is a clear click target with keyboard focus behavior.
- Status cells use text plus color or icon. Never rely on color alone.
- Rejection and payer denial are visually and verbally distinct.
- Source discrepancy and follow-up due can coexist as secondary flags.
- Tables need a sticky header, usable horizontal behavior only when unavoidable,
  and no clipped content at 1280px.
- At 390px, convert each row to an information-dense claim card. Do not squeeze
  the desktop table.

## 10. Page: Claim workbench `/claims/[id]`

### Goal

Resolve one claim while preserving source evidence, approval control, and a
clear audit trail.

### Header summary

- Patient
- Payer
- Claim ID
- Date of service
- Billed amount
- Human-readable primary status
- Resolution status
- Last verified time
- Flags such as source discrepancy, approval required, follow-up due, or
  verified paid

### Source lifecycle

Required ordered stages:

1. Encounter
2. Claim
3. Clearinghouse
4. Payer
5. Remittance
6. Posting

PMS is a source observation, not a seventh chronological transport stage.

For each populated stage show:

- Human-readable state
- Raw state as secondary detail
- Observed timestamp
- Evidence reference
- Synthetic marker where relevant

The current repeated full-height source cards should become a compact horizontal
or vertical timeline with expandable details. Missing stages should look pending
or absent, not broken.

### Discrepancy view

For Claim C, make the conflict understandable at a glance:

- PMS: Processing, observed 2026-07-01
- Payer: Denied, authorization required, observed 2026-07-10
- Deterministic finding: status conflict
- Supporting authorization-not-required evidence covering DOS 2026-06-12 and
  CPT 97110

Prefer a side-by-side source comparison or clearly connected timeline markers.
The user should not have to read every lifecycle card to discover the conflict.

### Financial reconciliation

- Billed
- Allowed
- Paid
- Posted
- Adjustment and patient responsibility when present

`Verified paid` gets a strong but restrained confirmation only when remittance
and posting agree. Missing amounts use explicit labels rather than ambiguous
blank space.

### Evidence drawer

- Evidence title
- Source
- Observed time
- Human-readable summary
- FHIR or document reference
- Synthetic badge
- Expand and copy affordances

The agent's citation chips should focus or highlight the matching evidence item.

### Agent workspace

The agent is claim-scoped. It supports:

- Status question
- Reason question
- Evidence question
- Next-action question
- Action request that creates a deterministic proposal

Required states:

- Initial suggested prompts
- Sending or thinking
- Grounded response with citation chips
- BFF unavailable or invalid response with no synthetic fallback
- Proposal ready for review
- Proposal denied with explicit no-write outcome
- Proposal recreated
- Approval running
- Receipt created and next follow-up shown
- Outcome pending verification

### Proposal and approval

Proposal presentation must clearly separate:

- What the agent found
- Evidence used
- Proposed action
- Target
- Artifact preview
- Impact or expected post-action state

The primary approval control is `Allow once`. `Deny` is destructive only to the
proposal, not to the claim. Explain that approval is bound to this proposal and
current claim revision without making the raw fingerprint primary UI.

After approval:

- Replace buttons with a clear execution result.
- Show domain receipt ID.
- Show next follow-up.
- Preserve the adjudication truth.
- Reflect updated approval and exception counts on the dashboard.

### Preferred composition

- Persistent claim summary header.
- Main evidence workspace on the left.
- Sticky agent and decision rail on the right at desktop widths.
- The agent rail may be 360px to 420px, but long artifact content must not force
  the entire page to become excessively tall.
- On mobile, order content as summary, discrepancy, next action, evidence,
  lifecycle, financials, activity. Approval controls must remain reachable and
  must not be hidden by a sticky composer.

## 11. Required fixture states

- Encounter A: completed, final note, active coverage, no claim, ready to submit
- Claim A: draft, ready to submit
- Claim B: payer accepted, remittance overdue, read-only refresh, never auto-paid
- Claim C: PMS processing versus payer authorization denial, request reprocessing
- Claim D: clearinghouse member ID rejection, correct and resubmit, preserve
  original and corrected claim relation
- Claim E: payer requested supporting note, send existing signed documentation
- Claim F: matching remittance and PMS posting, verified paid, no unsafe action

The design must account for all seven cases, even if the primary mockup focuses
on Claim C.

## 12. Responsive and accessibility acceptance

- 1440px: no clipped shell, tables, approval controls, or artifact preview.
- 1280px: queue, workbench, and agent rail remain usable without accidental
  horizontal page scrolling.
- 390px: single-column layout, navigation drawer, claim cards rather than a
  compressed table, no horizontal overflow.
- Keyboard users can reach navigation, filters, table or cards, chat input,
  evidence references, Deny, and Allow once in a logical order.
- Visible focus state on every interactive element.
- Inputs have visible labels or persistent accessible names.
- Status does not depend on color alone.
- Error, pending, success, and no-write states use text and live-region semantics.
- Minimum practical target size is 40px.
- Respect reduced-motion preferences.

## 13. Deliverables requested from Claude Design

Create one coherent responsive web product with these pages:

1. Practice overview dashboard
2. Encounter queue with selected claim preflight
3. Claims lifecycle queue
4. Claim C discrepancy workbench with agent conversation and proposal approval
5. Claim F verified-paid workbench state

Deliver:

- A shared design system with color, typography, spacing, radius, shadow, status,
  button, badge, filter, table, card, timeline, evidence, agent, and approval
  primitives
- Desktop mockups at 1440px
- A 390px mobile treatment for Claims and Claim workbench
- Meaningful hover, focus, selected, disabled, loading, error, denied, approved,
  and post-action states
- Production-oriented React and TypeScript code or exportable HTML and CSS that
  can be adapted into the existing Next.js app
- No new backend assumptions, fabricated metrics, or live-integration claims

## 14. Design QA checklist

A design iteration is not accepted if any of the following is true:

- It removes or hides the synthetic and no-live-write truth.
- It makes payer denial look like clearinghouse rejection or vice versa.
- It marks a claim paid after submission, acceptance, or reprocessing.
- It lets chat appear to execute a write without a proposal and Allow once.
- It omits source, timestamp, or evidence references from the central conflict.
- It renders all 17 claim attributes as equally important visible columns.
- It exposes raw snake-case states as the primary language.
- It turns the workbench into a generic chat page.
- It has clipped tables, buttons, or side panels at 1280px.
- It uses a compressed desktop table at 390px.
- It creates a large decorative hero, marketing layout, or consumer wellness UI.
- It invents live Medplum, Stedi, payer, or production security claims.

## 15. Reference assets

Current implementation screenshots are provided for functional reference, not
as a visual style target:

- `current-dashboard.png`
- `current-encounters.png`
- `current-claims.png`
- `current-claim-workbench.png`

The current public application can be inspected at the product URL above. Its
working interactions and data semantics must be preserved while its information
architecture, hierarchy, density, and visual quality are redesigned.
