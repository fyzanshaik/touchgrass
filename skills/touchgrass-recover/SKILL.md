---
name: touchgrass-recover
description: Diagnose and restore an existing Touchgrass deployment when adult-site blocking stops, a Mac or iPhone DNS profile is missing, browser routing changes, or Gateway synchronization fails.
---

# Recover Touchgrass filtering

Locate the user's Touchgrass clone, then read `AGENTS.md` and `docs/operations.md`.
Use `docs/setup.md` for profile generation and installation. A copied/global skill must
resolve the repository separately; do not assume its own directory contains project code.
Use the user's current endpoint, account, Worker and ignored config. Never substitute values
from a sample, another user or a prior session without verifying the target.

## Separate the failure paths

Begin with read-only evidence. Identify the affected device/browser, what changed, and
whether normal browsing still works. A restart alone is not evidence the profile disappeared.

- Inspect the installed profile and its DoH endpoint. New profiles display **Touchgrass DNS**;
  older compatible ones may display **ClearBrowse Test DNS**. Downloaded and installed are
  different states. On iPhone inspect **Settings → General → VPN & Device Management**;
  on Mac inspect **System Settings → Device Management**, allowing for OS label changes.
- Inspect the browser's secure DNS selection, active VPN and iCloud Private Relay. Record
  overrides before changing them. A profile is removable and does not force every browser
  or VPN to use its resolver. Do not disable unrelated settings without task scope.
- Inspect signed-in dashboard Diagnostics: desired/applied revisions, reconciliation state,
  errors and owned rules. Do not copy Access cookies or JWTs into shell commands or reports.
- If tools can safely probe the configured DoH endpoint directly, compare that result with
  the OS resolver and browser behavior. Keep direct Gateway, OS and browser evidence distinct.

A working Gateway with bypassed device DNS needs device repair. A working DNS path with a
broken dashboard needs management repair. They can fail independently; do not redeploy the
Worker merely because one browser can open a blocked domain.

## Repair the identified layer

For a missing or wrong profile, generate a new file using the verified deployment endpoint
and guide the user through installation. Reuse an existing valid file when appropriate.
Generation installs nothing, refuses overwrite and should stay in an ignored directory.
Preserve unrelated profiles and VPNs. If the location endpoint truly changed, each affected
device needs an updated profile; the dashboard cannot push that repair automatically.

For dashboard configuration/authentication failures, use the documented `503`/`401`/`403`
meaning and check the existing config. Preserve production/live mode, disabled local auth,
owner-only Access and JWT validation. Reauthenticate Wrangler or rotate the Gateway secret
only when the evidence requires it and the user's task authorizes that repair. Use the
verified ignored config path and keep `--env-file=/dev/null` last on Wrangler commands.
Never print tokens or turn authentication off to get a successful response.

For reconciliation failures, inspect the exact error and the live rule inventory against
Diagnostics before retrying. Read the ownership/precedence repair section in
`docs/operations.md`. Preserve the Durable Object, migrations, stored identity, owned rule
IDs and `clearbrowse:` prefix. Do not reset state, force-adopt, force-delete, recreate missing
owned rules, or move unrelated rules as an automatic repair. Explain any unresolved ownership
conflict and the specific repair needed; a reconciliation retry cannot fix missing ownership.

Use the dashboard's authenticated **Retry reconciliation** when a transient or corrected
configuration issue warrants it. Do not repeatedly retry permanent errors or send API
mutations without the required revision, idempotency and same-origin protections. Respect
cooldowns for weakening changes, including removal of test blocks and backup restoration.

## Verify recovery

Use `example.com` as an allowed control and `pornography.testcategory.com` as the safe
category-block probe. Test `example.org` only if the current policy explicitly blocks it.
Check relevant browsers in normal and private modes. When possible, verify both Wi-Fi and
cellular on iPhone and persistence after a restart. Cache effects may require a fresh browser
session before interpreting a repeated navigation.

Report the cause, change made, and evidence for each tested layer. Mark unavailable device
checks pending and label user-reported outcomes. A synchronized revision is backend evidence,
not proof of browser filtering. Finish without replacing the deployment or claiming that all
adult domains are covered.
