---
name: touchgrass-setup
description: Help deploy Touchgrass in the user's own Cloudflare account, preview the dashboard locally, or install and verify its DNS profile on Mac and iPhone for an individual or family.
---

# Set up Touchgrass

Locate the user's Touchgrass clone before running commands. Use the current working
repository when its `package.json` names `touchgrass`; otherwise ask for the clone path.
A globally installed copy of this skill is not the project root. Read the repository's
`AGENTS.md`, `README.md` and `docs/setup.md`. The setup guide is the maintained procedure;
resolve version-sensitive Cloudflare UI, API or Wrangler details from current official docs
and installed CLI help rather than inventing commands.

## Choose the starting point

Determine whether the user wants a local preview, a fresh Cloudflare deployment, or another
device on an existing deployment. Inspect existing configuration without exposing secrets
before creating resources. Reuse a working deployment when adding devices. For an existing
failure, follow `docs/operations.md` rather than starting onboarding again.

Collect only missing context that affects the next step: target devices/OS versions,
Cloudflare account and Zero Trust readiness, administrator identity, existing Worker/config
and Gateway location. Do not ask the user to paste tokens, cookies or JWTs into chat.

For families, one administrator manages one policy; each supported device uses the same
location-specific DNS profile. No app-imposed device cap or per-device fee applies, but
Cloudflare quotas and the application's rule limit still apply. Separate family-member
policies and tamper-proof child-device controls are not implemented. Independent deployments
need separate Cloudflare accounts because the `clearbrowse:` ownership namespace is
account-wide.

## Execute the requested setup

- For a preview, install the pinned dependencies and use `pnpm run dev:local`. It simulates
  Gateway and does not filter websites. Keep that distinction visible to the user.
- For real blocking, follow `docs/setup.md` in order. Preserve the bootstrap sequence:
  prepare ignored production config, deploy the fail-closed Worker, protect all its traffic
  with administrator-only Access, set the Gateway secret, then deploy complete live config.
- Use the user's verified config path and account for every deploy or secret operation.
  `wrangler.production.json` is the guide's fresh-deployment convention, not a reason to
  overwrite an existing config. Keep `--env-file=/dev/null` last on Wrangler authentication,
  deployment, secret and dry-run commands so an incidental `.env` cannot replace credentials.
- Keep the Gateway management token separate from Wrangler login. Use an interactive secret
  prompt or an available secret-management tool without printing the value. Keep credentials,
  account configuration and generated profiles out of tracked files.
- Production stays `ENVIRONMENT=production`, `GATEWAY_MODE=live`, `LOCAL_AUTH_ENABLED=false`.
  Preserve Access JWT validation, owner identity and disabled previews. A missing-setting
  `503` during bootstrap is expected; do not bypass authentication to make the page load.
- Create only resources in the requested setup scope. An instruction to explain setup or
  install this skill does not authorize deployment. A deployment request supplies its scope;
  do not request repetitive approvals for actions already authorized. Leave interactive login
  or device passcode steps to the user when tooling cannot complete them.

Generate the profile using the verified location-specific endpoint and the repository's
`generate:dns-profile` command from the guide. The generator refuses overwrites and installs
nothing. Never silently remove an existing profile file to make generation succeed. Guide
installation in macOS Device Management or iPhone VPN & Device Management; current OS labels
may differ. Do not claim a profile is installed just because it was downloaded or generated.

## Verify and report

Check desired/applied revisions and reconciliation state first, then the actual DNS/browser
path. Follow the guide's device matrix: `example.com` allowed, an explicitly added
`example.org` block denied, and `pornography.testcategory.com` denied. Do not treat
`example.org` as blocked unless its rule was actually configured. Removing that test rule is
a weakening change governed by the cooldown.

Check normal/private browsing, relevant browsers and networks, and persistence after restart
when the device is available. Inspect browser secure DNS, VPN and Private Relay if results
conflict. A green dashboard alone does not prove device protection. Record unavailable checks
as pending and distinguish direct observations from user-reported results. Finish with the
actual deployment/profile status, verified results and any concrete remaining user steps.
