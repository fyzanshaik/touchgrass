# Operations

Day-two behaviour, failure modes and recovery for a Touchgrass deployment. Read
[`setup.md`](setup.md) first if you have not deployed yet.

## Mental model

The Durable Object is the source of truth. It holds the **desired** policy and the
**applied** revision, plus outstanding cooldowns and the map of Gateway rules it owns. The
reconciler is a one-way writer: it reads Gateway, then creates, updates, re-precedences or
deletes only the rules it recognises as its own. It never adopts or deletes anything else.

- Desired revision: the policy you saved.
- Applied revision: the policy the reconciler last confirmed in Gateway.
- Reconciliation `idle` means they agree; `degraded` means they do not and an error code is
  set; `applying` means a change is in flight.

A dashboard sync is backend state. It is not evidence that any device is filtered.

## API surface and request rules

All routes are under `/api/v1` (`src/worker/app.ts`):

| Route | Purpose |
| --- | --- |
| `GET /policy` | Current desired policy and ETag (`"p-N"`) |
| `GET /status` | Revisions, reconciliation state, pending proposals |
| `GET /diagnostics` | Compiled plan, owned resources, reconciliation job |
| `GET /backup` | Export the desired policy as JSON |
| `POST /preview` | Validate a hostname before adding it |
| `POST /changes` | Apply a policy operation |
| `POST /restore` | Restore a backup |
| `POST /relaxations/:id/confirm` | Confirm an eligible weakening |
| `POST /relaxations/:id/cancel` | Cancel a pending weakening |
| `POST /reconcile` | Force a reconciliation check |

Every mutating request needs:

- An `If-Match` header of the form `"p-N"` matching the current desired revision.
- An `Idempotency-Key` header containing a UUID. Replaying the same key with the same body
  returns the stored result; reusing it for a different body returns `409`.
- `content-type: application/json`, plus a same-origin `Origin`/`Referer` and a
  same-origin (or absent) `Sec-Fetch-Site`. These are the CSRF checks in `src/worker/auth.ts`.

Authentication is the Cloudflare Access JWT in the `cf-access-jwt-assertion` header,
verified in `src/worker/access.ts` (RS256, issuer, audience, expiry). Only `OWNER_EMAIL` is
accepted; every other identity gets `403`.

## Backups, export and restore

Export (`GET /backup`) returns `{ exportedAt, sourceRevision, policy }` for the current
desired policy (`exportBackup` in `src/worker/account.ts`). Download it from the dashboard's
Diagnostics screen or the API.

The dashboard accepts either the full backup envelope or a bare policy object
(`src/web/state/backup.ts`). It extracts the policy and sends `{ policy }` to
`POST /restore`, which requires that request shape. On restore:

- If the backup's `dnsEndpoint` differs from the deployment's, it is rejected with
  `conflict` ("The backup belongs to a different Gateway endpoint"). This stops a backup
  from another location being applied to yours.
- Rules are rebuilt with fresh identifiers; entries are re-validated for duplicates and
  action conflicts.
- The result is classified like any other change. A restore that weakens protection becomes
  a pending proposal and **cannot bypass the cooldown**. An identical or stronger restore
  applies immediately (or is reported `unchanged`).

Idempotency records live for 24 hours (`IDEMPOTENCY_TTL_SECONDS` in `src/worker/store.ts`).

## Cooldowns and recovery

Changes are classified as `stronger`, `weaker` or `unchanged` in
`src/domain/operations.ts`. Turning protection on, adding a block, adding a category or
lengthening a cooldown are stronger. Turning protection off, removing a block, removing a
category, shortening a cooldown or adding an allow are weaker.

- Stronger and unchanged changes apply immediately.
- A weaker change becomes a **pending proposal**. It becomes confirmable at
  `eligibleAt = now + policy.cooldownSeconds` (default 24 hours, configurable up to 7 days;
  `src/domain/policy.ts`). It expires 7 days after it becomes eligible
  (`RELAXATION_EXPIRY_SECONDS` in `src/worker/account.ts`).
- Confirm with `POST /relaxations/:id/confirm`; cancel with
  `POST /relaxations/:id/cancel`. Confirming a stale proposal returns `stale_revision`;
  a proposal that no longer applies to the policy is cancelled automatically.

Recovery paths:

- **Proposal expired or stale.** Create the change again; you will get a fresh proposal and a
  fresh cooldown.
- **You want to re-strengthen while a weakening is pending.** Apply a stronger change. It
  applies immediately and may make the pending proposal stale so it should be cancelled.
- **Testing cooldowns.** Local mode uses real time by default, so a cooldown is a real wait.
  The controllable clock is a debug command on the Durable Object that the automated tests
  drive over RPC (`src/worker/account.ts`); it is not exposed over HTTP or in the dashboard, so
  there is no UI path to skip a cooldown in either local or production mode.

The alarm that expires proposals and retries reconciliation is armed before any awaited
Gateway call, so a crashed apply is resumed rather than lost (`src/worker/account.ts`).

## Reconciliation, ownership and precedence

The reconciler (`src/worker/reconciler.ts`) only ever **mutates** rules whose name starts with
the internal `clearbrowse:` prefix (`OWNED_RULE_PREFIX` in `src/worker/gateway.ts`). It does,
however, **read the whole account rule inventory** — every rule's precedence — so it can
position its own rules without colliding. It never relocates, renames or deletes a rule it
did not create. The prefix is a compatibility boundary: it stays even though the project is
called Touchgrass.

Guards, in order:

- **Drift** (`drift`): a `clearbrowse:` rule exists in Gateway that has no recorded owned
  resource and is not in the plan. The reconciler will not adopt it. It stops and marks the
  account `degraded`.
- **Collision** (`collision`): a recorded resource's Cloudflare id no longer matches the
  rule with that name, or a recorded rule is missing from Gateway. Stopping is safer than
  recreating, because a recreated rule gets a new id and could duplicate a rule someone else
  placed.
- **Read-back mismatch** (`gateway_readback_missing` / `gateway_readback_mismatch`): Gateway
  accepted a write but the read-back does not match the plan (action, traffic or ordering).
- **Precedence** (`precedence_taken`): the target precedence is held by a rule the project
  does not own. Owned rules are relocated to make room — earlier for a `block` (temporarily
  stricter), later for an `allow` (conservative) — but unowned rules are never moved, and
  renaming an unowned rule does not free its slot (renaming does not change precedence).
- **Incomplete inventory** (`invalid_response`): pagination could not read the whole rule
  inventory, so the reconciler fails closed rather than acting on a partial view.

`collision`, `drift`, `invalid_response` and `precedence_taken` are **permanent**: they are
never retried automatically, so the degraded state stays visible until you act. Transient
errors (`timeout`, `rate_limited`, `unauthorized`, `forbidden`, `unavailable`) are retried
with exponential backoff from 5 seconds up to 900 seconds
(`BASE_BACKOFF_SECONDS`/`MAX_BACKOFF_SECONDS`).

There is deliberately **no force-adopt and no force-delete path**. Repair by hand:

1. Zero Trust > Gateway > DNS policies. Filter by name for `clearbrowse:`.
2. Compare against `GET /api/v1/diagnostics` > `ownedResources` and `planRules`.
   - Untracked `clearbrowse:` rule: rename it to a name outside the prefix. Renaming is the
     only safe action; the reconciler will not adopt it.
   - Tracked rule with edited contents: restore the known-good contents on the same rule id,
     then retry. Do not delete it.
   - Tracked rule whose recorded id is gone: treat this as an ownership repair; do not
     delete-and-recreate, because the new id is rejected as `collision`.
   - Unowned rule occupying a needed precedence: move it to a different precedence yourself,
     or change `GATEWAY_PRECEDENCE_BASE` so the plan no longer targets that slot. Renaming it
     does not help, because renaming does not change precedence.
3. `POST /api/v1/reconcile` with the current `If-Match` and a fresh `Idempotency-Key`.
4. Confirm `GET /api/v1/status` is `idle` with `gatewayAppliedRevision == desiredRevision`.

A relocation that fails partway can leave a rule temporarily stricter (a `block` moved to an
earlier precedence) before the account settles. A historically matching applied revision does
not, by itself, prove the remote ordering is unchanged now; compare `GET /api/v1/diagnostics`
`planRules` against the live ordering whenever exact order matters.

## Failure modes

**Configuration and authentication (`503`).** The Worker fails closed. If any required
setting is blank or the environment is not production/live with local auth disabled,
every request returns `503` naming the missing settings (`decodeConfig` in
`src/worker/config.ts`). A `503` also appears if authentication itself is unavailable.

**Authentication (`401`/`403`).** A missing or invalid Access JWT is `401`; an authenticated
identity other than `OWNER_EMAIL` is `403`. Local mode additionally refuses any non-loopback
hostname.

**Dashboard versus DNS.** These fail independently:

- The dashboard can be up while devices are unprotected — no profile installed, profile
  removed, resolver overridden by a browser/VPN, or the device on a network that reshapes
  DNS.
- DNS filtering can be working while the dashboard is unavailable — Worker down, Access
  misconfigured, or blank config returning `503`.

Use `GET /api/v1/diagnostics` and the OS resolver, not the dashboard alone, to tell them
apart.

**Profile removed or endpoint changed.** If a device loses the profile, reinstall it from
`setup.md`. If the DoH endpoint changes, the profile must be regenerated and reinstalled on
every device; the dashboard cannot install or repair a profile for you. Removing the profile
or changing resolver settings is always possible — a cooldown cannot prevent it.

## Logs and token rotation

- Worker logs and Gateway DNS logs are available in the Cloudflare dashboard depending on
  your plan and account settings. Workers Logs are included on Free and Paid plans with
  limited retention; confirm current retention and pricing.
- To rotate the Gateway management token: create a new token, run
  `pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --config wrangler.production.json --env-file=/dev/null`,
  deploy, verify `idle`, then revoke the old token. Keep Wrangler's own authentication
  separate from this token.
- Never place the token in `wrangler.production.json`, `.env` or source. Always pass
  `--env-file=/dev/null` last for authenticating commands.

## Privacy and provider involvement

- Devices send DNS queries over HTTPS to Cloudflare's Gateway endpoint. Cloudflare resolves
  and filters them and, for a location-based endpoint, can log them to your account
  according to your Gateway/Zero Trust logging settings.
- The DoH connection is encrypted in transit, but Cloudflare is the DNS provider for the
  location and can see queried names. This is the trust you place in your own Cloudflare
  account by choosing Gateway.
- Filtering is name-based. Gateway sees the requested domain, not page content, paths or
  posts, so it cannot filter content within a domain.
- The DoH endpoint is not a credential. Protect the dashboard with Access, and rotate the
  management token if it leaks.

## Updating an existing deployment

All settings live in `wrangler.production.json` (git-ignored) and Worker secrets. To change
them:

```sh
# edit wrangler.production.json with your values
pnpm run build:web
pnpm exec wrangler deploy --config wrangler.production.json --env-file=/dev/null
```

Changing the Durable Object binding, class or migrations is a state change: preserve the
existing binding and stored account identity. Never recreate the Durable Object as a
shortcut for an ownership repair — that discards the owned-resource map and turns every
existing Gateway rule into drift.

The service never upgrades your plan, never force-adopts or force-deletes rules, and never
removes unrelated Gateway rules or DNS locations.
