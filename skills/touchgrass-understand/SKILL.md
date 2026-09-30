---
name: touchgrass-understand
description: Explain Touchgrass's product scope, family setup, architecture, code relationships and policy behavior from the repository, including its DNS filtering limits.
---

# Understand Touchgrass

Locate the Touchgrass clone using its `package.json` name; ask for the path if the current
workspace is unrelated. Installed skill paths are not repository paths. Read `README.md`
and `AGENTS.md`, then load `docs/setup.md` for onboarding questions or
`docs/operations.md` for policy and runtime behavior. Keep this workflow read-only unless
the user also requests changes.

## Explain the product accurately

Touchgrass is self-hosted adult-domain blocking on Cloudflare for an individual or a family
sharing one policy. An Apple encrypted DNS profile directs eligible device DNS requests to
Cloudflare Gateway. The Worker is the management service, not a VPN or web-traffic proxy.
No native app or paid Apple Developer membership is required.

One administrator manages category and custom domain rules for multiple devices. There is
no app-imposed device cap or paid software tier. Cloudflare service limits still apply and
the application has a bounded custom-rule capacity. It does not provide separate child
accounts, per-member policies, a guaranteed child-safe internet, content filtering inside
Reddit/X, or tamper-proof profile enforcement. Browser DNS, VPN and Private Relay can change
the path; an installed profile and synchronized Gateway are separate requirements.

## Trace the requested behavior

Use this source map to choose the smallest relevant read:

| Question | Start here |
| --- | --- |
| API routing and deployment entry point | `src/worker/index.ts`, `src/worker/app.ts` |
| Production config and authentication | `src/worker/config.ts`, `src/worker/access.ts`, `src/worker/auth.ts` |
| Policy, hostname validation, cooldown classification | `src/domain/policy.ts`, `src/domain/hostname.ts`, `src/domain/operations.ts` |
| Gateway rule compilation | `src/domain/plan.ts`, `src/domain/traffic.ts` |
| Stored state, revisions and proposals | `src/worker/account.ts`, `src/worker/store.ts`, `src/worker/sql.ts` |
| Gateway inventory, writes, ownership and retries | `src/worker/gateway.ts`, `src/worker/reconciler.ts` |
| Shared request/response schemas | `src/contracts/` |
| Dashboard behavior and state | `src/web/screens/`, `src/web/state/`, `src/web/client/` |
| Profile generation and payload | `scripts/generate-dns-profile.ts`, `src/dns-profile/` |

When Graphify is available, query an existing `graphify-out/` map first for code relationships
and verify the relevant source before drawing conclusions. Maps may be stale and may not
exist in a fresh clone. Use file search and source reads when Graphify is unavailable; it is
not a prerequisite for understanding or deploying Touchgrass. Keep secrets and generated
profiles out of any new map.

Explain both paths when architecture matters:

1. Browser/system DNS → installed profile → Gateway category/custom rules → allowed answer
   or blocked resolution. Ordinary web traffic is not sent through the Touchgrass Worker.
2. Administrator → Cloudflare Access → React dashboard → Hono API → SQLite Durable Object
   → reconciliation through the Gateway API.

The Durable Object stores desired policy, pending cooldown proposals, applied revision and
owned-resource records. Reconciliation changes only rules it owns. The `clearbrowse:`
Gateway prefix and legacy DNS profile identifier are compatibility boundaries; they are not
signs of an incomplete rename and must not be casually changed.

## Ground the answer

Use code and maintained docs for implemented behavior; use current official Cloudflare or
Apple sources when answering provider limits or OS-specific questions. Show file paths and
symbols that substantiate technical claims. Distinguish implemented features, proposals,
local test evidence and real-device observations. Use a small Mermaid diagram when it
clarifies the requested flow, and describe limitations relevant to the question without
promising complete category coverage or unlimited infrastructure.
