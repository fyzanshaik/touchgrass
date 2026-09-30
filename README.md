# Touchgrass

Touchgrass is personal adult-website filtering for one person's iPhone and Mac, using
that person's own Cloudflare account. Enforcement is a manually installed encrypted DNS
profile (DNS over HTTPS) that points at a Cloudflare Gateway DNS location. The application
in this repository is the private dashboard and the account service that compile and
reconcile your filtering policy into Gateway rules.

No native app is involved and no paid Apple Developer membership is required.

This repository is generic: it ships blank owner, account, Access and DNS settings so a
new owner can deploy their own isolated copy. It is **single-owner per deployment**, not a
multi-tenant service.

## What it does

- Stores a small policy: a protection on/off switch, the pornography category, and custom
  block/allow rules scoped to a hostname or a domain and its subdomains.
- Compiles that policy into Cloudflare Gateway DNS rules scoped to your Gateway location,
  and reconciles them (create, update, delete, re-precedence) against what the account
  actually reports.
- Applies a cooldown to weakening changes so you cannot trivially switch protection off or
  unblock something on impulse.
- Backs up and restores the policy as JSON.
- Serves a private dashboard behind Cloudflare Access, restricted to a single owner
  identity.
- Runs a simulated Gateway whose state lives in the Durable Object, so you can exercise the
  whole lifecycle without touching any Cloudflare account.

## Single-owner model

One deployment serves exactly one owner, in one Cloudflare account:

- Exactly one Worker, one SQLite-backed Durable Object instance (the `owner` object), and one
  authorised identity (`OWNER_EMAIL`).
- Requests authenticated as any other identity are rejected with `403`. There is no signup,
  no user list and no sharing.
- The service manages only the Gateway rules it created, identified by an internal ownership
  name prefix. It observes other rules' precedence to position its own, but never mutates
  anything it did not create.

That ownership prefix is account-wide, so **run each independent deployment in its own
Cloudflare account**. Two copies in one account would each treat the other's rules as drift.
For more than one person, repeat the setup with a separate account, Worker and Gateway
location per person.

## Architecture

```text
 iPhone / Mac
   │  system DNS (encrypted, DoH)
   ▼
 https://<location>.cloudflare-gateway.com/dns-query
   │
   ▼
 Cloudflare Gateway  ── DNS location ──►  DNS policies
   ▲                                        ▲
   │  management API (scoped token)         │  reconcile
   │                                        │
 Cloudflare Worker (Hono)  ──────────►  SQLite Durable Object
   │  serves dashboard + /api/v1            (policy revisions, cooldowns,
   │                                         owned rule map, checkpoints)
   ▲
   │  owner-only Cloudflare Access (JWT)
 Browser dashboard (React + Vite)
```

The Worker is the only writer of its own rules. The Durable Object is the single source of
truth for the desired policy, what has been applied, and outstanding cooldowns.

## Stack and prerequisites

| Layer | Choice |
| --- | --- |
| Language | TypeScript, strict, no `any`, no assertions, comments enforced off in source |
| Runtime | Cloudflare Workers (`wrangler`, `workerd`) |
| HTTP | Hono |
| Contracts and errors | Effect Schema, typed Effect errors |
| State | One SQLite-backed Durable Object (`AccountDurableObject`) |
| Dashboard | React 19 + Vite, built to `dist/web`, served as Worker assets |
| Auth | Cloudflare Access JWT (RS256) verified in the Worker, same-origin CSRF checks |

- Node.js `>=22.18.0` (the `engines` field and `packageManager` pin the toolchain).
- pnpm `11.9.0`.
- Cloudflare account with Workers (the Free plan is enough) and Zero Trust enabled.
- Wrangler `4.x` (installed as a dev dependency; run it through `pnpm exec`).

## Local quickstart (safe, no traffic filtering)

Clone a copy you have access to and install the pinned pnpm version if needed:

```sh
git clone YOUR_REPOSITORY_URL touchgrass
cd touchgrass
npm install --global pnpm@11.9.0
```

Replace `YOUR_REPOSITORY_URL` with your repository's clone URL. A private repository
requires GitHub access; the MIT license permits reuse of copies you obtain.

This runs a simulated Gateway whose state lives in the Durable Object. It does not contact
Cloudflare and does not change DNS on any device.

```sh
pnpm install --frozen-lockfile
pnpm run dev:local
```

Then open <http://127.0.0.1:8787>. Local mode accepts loopback requests only, uses
`ENVIRONMENT=local` with local authentication, and reports `gatewayMode: "simulated"` so
simulated state is never mistaken for live management read-back. Local mode uses real time,
so cooldowns behave exactly as they will in production; there is no dashboard control to
skip them.

Useful checks against the running server:

```sh
curl -s http://127.0.0.1:8787/api/v1/status
curl -s http://127.0.0.1:8787/api/v1/diagnostics
curl -s http://127.0.0.1:8787/api/v1/policy
```

For dashboard work, run `pnpm run dev:web` in a second shell; it rebuilds `dist/web` and the
running server serves the new assets within seconds without a restart.

Local overrides go in `.dev.vars` (git-ignored). See `.dev.vars.example`. Nothing in local
mode needs a real Cloudflare token.

## Behaviour

- **Rules.** Each rule is a hostname plus a `block` or `allow` action and a scope. A `host`
  scope matches exactly that name; a `domain` scope matches the name and its subdomains.
  One hostname and scope can carry only one action.
- **Category.** The `pornography` category maps to a Gateway content category and is
  compiled into a single category rule.
- **Cooldowns.** Changes are classified as stronger (more restrictive), weaker or unchanged.
  Stronger and unchanged changes apply immediately. A **weaker** change is recorded as a
  pending proposal and only becomes confirmable after the cooldown elapses (default 24
  hours, configurable up to 7 days). A pending proposal expires 7 days after it becomes
  eligible. A restore is classified the same way and cannot bypass a cooldown.
- **Suppressed allows.** An allow that is already covered by a broader block is suppressed
  and reported in diagnostics rather than compiled into a contradictory rule.
- **Subdomains.** A `domain` rule such as `example.org` matches `example.org` and any
  subdomain; the Gateway expression uses a domain-list match, not a wildcard.

## Production setup

Deployment is manual and owner-driven. At a high level:

1. Create a Gateway DNS location and note its location-specific DoH endpoint.
2. Create a scoped Gateway management token and log in to Wrangler with OAuth.
3. Fill a private, git-ignored config and deploy once (the first deploy fails closed).
4. Enable owner-only Cloudflare Access for that Worker; record the team domain and AUD.
5. Store the token as a Worker secret, redeploy, sign in and confirm the policy syncs.
6. Generate the `.mobileconfig` profile into `generated/` and install it on each device.

The full walkthrough, including exact commands and verification, is in
[`docs/setup.md`](docs/setup.md). Day-two behaviour, failure modes and recovery are in
[`docs/operations.md`](docs/operations.md).

## Verification

```sh
pnpm install --frozen-lockfile
pnpm run verify
```

`verify` runs, in order: `wrangler types`, type checking for the node, Worker and web
projects, the source-rule check, the domain and profile tests, the dashboard tests, the
Vite build, the Worker runtime tests (local, production-boundary and unconfigured) and a
`wrangler deploy --dry-run` bundle check. `build:web` must run before `test:worker` or
`bundle:worker`, because the asset binding points at `dist/web`; `verify` already orders
this.

Wrangler commands that read or authenticate use `--env-file=/dev/null` so a local `.env`
holding a deploy credential cannot silently replace the intended one.

## Device evidence versus promises

Local tests cover policy, compilation, cooldowns, the Durable Object and HTTP boundaries in
the real Workers runtime. They do **not** prove that any browser uses the DNS endpoint.

- On the reference deployment, macOS browsers were directly observed passing an allowed
  control and rejecting custom and category probes (reserved test hostnames), in regular and
  private windows.
- iPhone blocking was self-reported by the owner, with ordinary sites loading and blocking
  persisting across Wi-Fi, cellular and a restart.
- New browsers, other networks and lifecycle events remain unverified until tested.

A successful policy sync means Gateway has your rules; it is not proof that a device is
filtered. Treat device and browser checks as a separate acceptance step you perform
yourself. See [`docs/setup.md`](docs/setup.md) for the test matrix.

## Cost and free tier

- The Workers Free plan includes 100,000 requests per day and Durable Objects with SQLite
  storage. This project fits comfortably in that for personal use, but exact limits and
  what is billable change over time.
- SQLite-backed Durable Object storage billing began in January 2026; the Free plan includes
  a daily read allowance and a small stored-data allowance. Check the current numbers before
  relying on them.
- The Workers Paid plan starts at $5 USD per month and is not required by this project.
- The service never upgrades your plan or makes purchases on your behalf.

Always confirm current limits against the source of truth:
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Limits

- **Cooperative, not tamper-proof.** The profile is removable in device settings and the
  Cloudflare account is yours. This is self-control software, not enforcement against a
  determined user.
- **DNS sees names, not content.** It can block an entire domain, but it cannot filter
  content *within* a domain such as a particular subreddit or an account on a social site.
  Site-internal content needs the provider's own controls.
- **Bypass paths exist.** A browser configured with its own secure DNS provider, a VPN, or
  iCloud Private Relay can avoid the system resolver. Category coverage is not exhaustive
  and cannot be claimed as universal.
- **The DoH endpoint is not a secret.** It identifies a location, not a credential. Anyone
  who knows it can send queries to that location, so keep the dashboard itself behind
  Access.
- **No native app.** Distribution is a manual profile install, not an App Store app.

## Layout

```text
src/domain/       pure policy, hostname, operation and compiler logic
src/contracts/    Effect Schema HTTP contracts shared with the dashboard
src/worker/       Worker, Durable Object, store, Gateway adapters, auth, reconciler
src/web/          React dashboard source
web/index.html    dashboard HTML entry point for Vite
scripts/          DNS profile generator and source-rule check
tests/            node tests, Worker runtime tests, dashboard tests
docs/             setup and operations guides
.github/          credential-free CI
```

## Contributing and source rules

This project enforces its TypeScript rules mechanically through `pnpm run verify` and
`src/quality/source-rules.ts`: no comments in source, no `any`, no type assertions, no
non-null assertions and no suppression directives. Strict TypeScript options such as
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on. Decode external input
from `unknown` at boundaries with Effect Schema and model expected failures as typed Effect
errors. Tests must cover behavioural boundaries and failure cases.

If you change structure, run `pnpm run verify` before proposing a change. Operational
procedures live in [`docs/operations.md`](docs/operations.md).

## License

MIT. See [`LICENSE`](LICENSE).
