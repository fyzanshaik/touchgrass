# Touchgrass agent instructions

## Project

Touchgrass is a self-hosted, single-owner adult-domain blocker for Mac and iPhone.
Enforcement uses a manually installed encrypted DNS profile and the owner's
Cloudflare Gateway location. A Cloudflare Worker serves the React dashboard and
Hono API; a SQLite Durable Object stores policy, cooldowns and reconciliation state.
Read `README.md`, `docs/setup.md` and `docs/operations.md` before deployment work.
No native app, paid Apple Developer membership or packet-tunnel VPN is required.

## Commands

- `pnpm install --frozen-lockfile`: install the pinned workspace dependencies.
- `pnpm run dev:local`: build and serve the local simulated dashboard at loopback
  port 8787. It does not filter traffic or change Cloudflare Gateway.
- `pnpm run dev:web`: rebuild dashboard assets as source changes.
- `pnpm run verify`: generate Worker types, check TypeScript/source rules, run
  domain/profile/web/Worker tests, build the dashboard and dry-run the Worker bundle.
- Build web assets before standalone Worker tests or bundle checks.

## Coding rules

- Use TypeScript, pnpm, Effect, Hono and React/Vite. Use Effect Schema to decode
  external input from `unknown`; preserve typed errors at service boundaries.
- Preserve strict configuration, including `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch` and `noPropertyAccessFromIndexSignature`.
- Add no `any`, unchecked assertions, non-null assertions, suppression directives
  or lint-disable escapes. Prefer inference, `satisfies` and `as const`.
- Add no source comments or docblocks. Explain decisions in Markdown and use clear
  names/modules. Do not hand-edit generated/vendor files to enforce these rules.
- Verify meaningful behavior and failure boundaries rather than mirroring code.
- Use Graphify for mapping relationships when useful. Query an existing graph first;
  do not include credentials, generated dependencies or personal logs in maps.

## Configuration and deployment

- Keep account identifiers, owner email, Access settings and DNS endpoint in ignored
  local deployment configuration. The tracked configuration is a generic template.
- Never commit credentials, `.env`, `.dev.vars`, generated profiles, local Durable
  Object state, personal verification logs or historical agent transcripts.
- Keep the Gateway management token in a Worker secret. Wrangler deploy credentials
  are separate; follow the documented `--env-file=/dev/null` command pattern.
- Production must remain live-mode and owner-authenticated. Preserve Access JWT
  verification, origin/CSRF checks, fail-closed configuration and disabled previews.
- Retrieve current Cloudflare docs/installed Wrangler schema before changing account
  setup or CLI/config behavior. Do not assume a connected MCP has every permission.
- Do not deploy or mutate external resources without scope established by the task.

## Policy and state boundaries

- Preserve the existing Durable Object binding/class, migrations and stored account
  identity on upgrades. Never recreate state as a shortcut for ownership repair.
- Keep the internal `clearbrowse:` Gateway ownership namespace stable. It is a
  compatibility boundary even though the project/display name is Touchgrass.
- Preserve unrelated Gateway rules and DNS locations. Reconciliation must not adopt
  unknown rules, force-delete collisions or guess ownership after drift.
- Serialize shared infrastructure mutations. Parallel writers require isolated
  worktrees or explicitly non-overlapping file ownership.
- Cooldowns delay relaxations; they do not prevent an owner from removing a DNS
  profile or changing resolver settings. Do not advertise tamper-proof protection.

## Agent coordination and evidence

Follow the user's current agent/delegation workflow and global instructions.
The parent owns scope, architecture, tracker management and final review; delegated
workers receive bounded tasks and report actual changes and validation evidence.
Do not infer correctness from an idle/done agent state.

Keep local tests, direct Gateway probes, OS resolver observations, browser checks
and owner-reported results distinct. Dashboard synchronization is backend state,
not proof of device protection. Test ordinary allowed browsing alongside blocked
domains in regular/private modes and across relevant networks/lifecycle events.
Record attribution limits from existing extensions, VPNs or resolver overrides.
