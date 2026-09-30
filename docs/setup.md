# Setup

A fresh-clone, end-to-end guide to deploying your own Touchgrass instance and installing
the DNS profile on your devices.

Use **one Cloudflare account per independent deployment**. The reconciler's ownership
namespace is account-wide: it lists every Gateway rule in the account to learn which
precedences are taken, and it treats any rule carrying its ownership prefix that it did not
create as `drift`. Two copies sharing one account would each see the other's rules as drift
and degrade. A deployment has one administrator and one shared policy; multiple devices
can use that policy, including devices in one household. For independent policies, use
separate Cloudflare accounts, Workers, Gateway locations and Access applications. The
ownership prefix is a compatibility boundary and is not changed by this guide.

There is no native app, no WARP client and no paid Apple Developer membership involved.

## What you are building

- A Cloudflare Gateway DNS location with a DoH endpoint.
- A Cloudflare Worker that holds your policy and reconciles it into Gateway rules, served
  behind owner-only Cloudflare Access.
- A `.mobileconfig` DNS profile installed by hand on each device.

Account setup (locations, tokens, Access, secrets) is done by you in the Cloudflare
dashboard and CLI. Policy ([block/allow rules, categories and cooldowns](operations.md))
is done for you by the application after it is deployed.

## Prerequisites

- A Cloudflare account dedicated to this deployment. The Workers and Zero Trust Free plans
  are sufficient.
- Zero Trust enabled on the account (you will be prompted to choose a team name).
- Node.js `>=22.18.0` and pnpm `11.9.0`.
- This repository cloned, and `pnpm install --frozen-lockfile` run once.

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
```

Cloudflare onboarding is performed by you in the dashboard; nothing here creates an account
for you.

## Step 1: Create a Gateway DNS location

1. In the Cloudflare dashboard, go to **Zero Trust** > **Networks** > **Resolvers** >
   **DNS locations** (the path may read **Gateway** > **Firewall policies** > **DNS
   locations** depending on the current UI).
2. Create a location and name it recognisably.
3. Copy the location's **location-specific DoH endpoint**:

   ```text
   https://<location-subdomain>.cloudflare-gateway.com/dns-query
   ```

   This is `GATEWAY_DOH_ENDPOINT`. The application derives the location label from the
   endpoint's first hostname label; changing it later means reinstalling the profile on every
   device.

The endpoint identifies a location, not a secret. Keep the dashboard behind Access anyway.

Source: [DNS over HTTPS (DoH)](https://developers.cloudflare.com/cloudflare-one/networks/resolvers-and-proxies/dns/dns-over-https/).

## Step 2: Choose a precedence base

Gateway rule precedence is account-global and unique within the account. Review your
existing Gateway DNS rules and pick a `GATEWAY_PRECEDENCE_BASE` that does not collide with
anything you want to keep.

- The compiler assigns precedence positionally: `GATEWAY_PRECEDENCE_BASE + index`.
- The reconciler observes every rule's precedence so it can position its own rules. It only
  ever mutates the rules it owns; it will not relocate, rename or delete a rule it does not
  own. If a needed slot is held by an unrelated rule, the write fails with
  `precedence_taken` and the account stays `degraded` until you resolve it yourself.

A common starting point is `1000` if that range is free. Verify it rather than assuming.

## Step 3: Create the Gateway management token

Create an **account-scoped** API token that can manage Zero Trust / Gateway resources for
the account that holds your DNS location:

1. **My Profile** > **API Tokens** > **Create Token**.
2. Scope it to the account that holds the DNS location.
3. Add the permission the Gateway rules API requires. The broad, supported option is
   **Account → Zero Trust → Edit** (write access to Cloudflare Zero Trust resources).
   Use the current API permission reference if choosing narrower permissions; the app
   needs both rule writes and read-back of the rule/category inventory.
4. Copy the value once.

This is a **Gateway management token**, not a Wrangler deploy credential. Permission names
change; confirm against
[API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

## Step 4: Authenticate Wrangler

Wrangler authenticates to Cloudflare separately from the Gateway token, and it genuinely
needs your account for deploy and secret operations. Log in with OAuth:

```sh
pnpm exec wrangler login --env-file=/dev/null
pnpm exec wrangler whoami --env-file=/dev/null
```

`whoami` should show the account you just created. Never store the Gateway token in a file
that Wrangler reads as its own credential.

## Step 5: Prepare your private config

The repository ships a generic `wrangler.json` with blank owner, account, Access and DNS
values. It fails closed in production: with those blanks the Worker refuses every request
with `503` naming the missing settings, so nothing is served unauthenticated.

Copy it to the git-ignored production config:

```sh
cp wrangler.json wrangler.production.json
```

Edit `wrangler.production.json` and fill in:

| Field | Your value |
| --- | --- |
| `account_id` | Your account id (add it; must match the Gateway account) |
| `name` | Your Worker name (lowercase, dashes allowed; used in the workers.dev hostname) |
| `vars.GATEWAY_DOH_ENDPOINT` | The location-specific DoH endpoint from Step 1 |
| `vars.GATEWAY_PRECEDENCE_BASE` | The free base from Step 2 |
| `vars.CLOUDFLARE_ACCOUNT_ID` | The same account id |
| `vars.ACCESS_TEAM_DOMAIN` | Leave blank for now (filled in Step 8) |
| `vars.ACCESS_AUD` | Leave blank for now (filled in Step 8) |
| `vars.OWNER_EMAIL` | Leave blank for now (filled in Step 8) |

Leave `ENVIRONMENT=production`, `GATEWAY_MODE=live` and `LOCAL_AUTH_ENABLED=false` as they
are. `wrangler.production.json` is git-ignored; keep it that way.

## Step 6: Bootstrap deploy (fail closed)

A Worker must exist before you can enable Worker-scoped Access for it, so deploy once now
with Access still blank:

```sh
pnpm run build:web
pnpm exec wrangler deploy --config wrangler.production.json --env-file=/dev/null
```

This first deploy is intentionally fail-closed: blank Access settings make every request
return `503`, so the Worker exists but serves nothing. You do not yet need the Gateway
secret.

**Why the tracked template omits `secrets.required`.** Wrangler verifies `secrets.required`
at deploy time. For a Worker that does not exist yet it refuses, because a secret cannot be
set on a Worker that is not there: "This Worker does not exist yet, so secrets cannot be set
in advance with `wrangler secret put`." Declaring the secret as required in the tracked
template would therefore make this bootstrap deploy impossible. The application already
fails closed at runtime when `CLOUDFLARE_API_TOKEN` is missing. If you want Wrangler to
enforce the secret from the first deploy, supply it up front with
`wrangler deploy --secrets-file <path>`; otherwise set it in Step 8 and, once it exists, you
may add `"secrets": { "required": ["CLOUDFLARE_API_TOKEN"] }` back to your private config so
a later deploy cannot remove it.

## Step 7: Enable owner-only Access for this Worker

Now that the Worker exists, protect it:

1. **Workers & Pages** > select your Worker > **Access**.
2. Choose **Protect this Worker behind Access** and cover all traffic (not previews only).
3. Configure an allow policy limited to your email address, and nothing else.
4. Apply. Do not add a bypass policy and do not make the Worker public.

This is a Worker-scoped Access application (API destination type `worker`), which protects
the Worker's routes, Custom Domains and workers.dev hostname together. It is the right fit
here because the application is a Worker with no separate hostname domain.

Collect the two Access values:

- **Team domain**: **Zero Trust** > **Settings** > **Team domain**, shaped
  `https://<team>.cloudflareaccess.com`.
- **AUD tag**: open the Access application and copy its **Application Audience (AUD) Tag**
  from the application details (or list applications with
  `GET /accounts/{account_id}/access/apps` and read the `aud` field).

Source: [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

## Step 8: Configure the secret and settings, then deploy

Fill `vars.ACCESS_TEAM_DOMAIN`, `vars.ACCESS_AUD` and `vars.OWNER_EMAIL` in
`wrangler.production.json`, then store the Gateway token as a Worker secret (interactive
paste; never in a file):

```sh
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN \
  --config wrangler.production.json \
  --env-file=/dev/null
```

Redeploy so the Access values take effect:

```sh
pnpm run build:web
pnpm exec wrangler deploy --config wrangler.production.json --env-file=/dev/null
```

**Why `--env-file=/dev/null`.** Wrangler loads a project `.env` if present, and a
`CLOUDFLARE_API_TOKEN` there can replace Wrangler's own credential, producing "No access to
the specified resource". Passing `--env-file=/dev/null` last neutralises any local `.env`.
Use it for every authenticating command and for local dry-runs and type generation. Keep
passing `--config wrangler.production.json` for every deploy and secret operation.

## Step 9: First login and bootstrap

Open your Worker hostname in a browser. Access prompts you to sign in; only `OWNER_EMAIL` is
allowed. After sign-in you land on the dashboard.

Use the dashboard first rather than editing Gateway by hand:

- On first request the service seeds a policy: revision 1, protection on, the pornography
  category, and the default cooldown.
- It then reconciles that policy into Gateway rules automatically.
- Use **Retry reconciliation** if you want to force a check.

## Step 10: Verify desired/applied sync and owned rules

Confirm the service is in sync, not merely that it saved your input. Inspect the dashboard's
**Overview** and **Diagnostics** screens (same origin as your signed-in session; no cookie or
token handling needed):

- Reconciliation shows **idle** with the Gateway applied revision equal to the desired
  revision.
- Diagnostics lists owned resources that are all app-managed, with no unexpected suppressed
  allows.

A `503` error page instead means a setting is still blank; the response names it. Fix
`wrangler.production.json`, redeploy, and retry.

## Step 11: Add a safe test rule

Add a harmless block you can verify without visiting anything adult. `example.org` is a
reserved documentation domain and resolves normally outside the tunnel:

1. In the dashboard, add a **domain** block for `example.org`.
2. Confirm the desired revision increments, the Gateway applied revision catches up, and
   reconciliation returns to **idle**.
3. `example.org` should now resolve to the Gateway block marker through your DoH endpoint
   and fail to load in a filtered browser, while `example.com` still loads.

Remove the test rule when done. Removal is a weakening change and goes through the cooldown;
that is expected.

## Step 12: Generate the DNS profile

Generate the profile into the git-ignored `generated/` directory:

```sh
mkdir -p generated
pnpm run generate:dns-profile \
  "https://<location-subdomain>.cloudflare-gateway.com/dns-query" \
  generated/touchgrass.mobileconfig
```

The generator refuses to overwrite an existing file, writes the profile with mode `0600`,
and touches no device settings. `generated/` and `*.mobileconfig` are git-ignored so you do
not accidentally publish a profile.

New profiles display **Touchgrass DNS**. Older installations may display **ClearBrowse
Test DNS**; the internal profile identifier remains unchanged for compatibility. Generating
a new file does not alter a profile already installed on a device.

## Step 13: Install on Mac and iPhone

**Mac:** open the `.mobileconfig`. macOS opens a profile prompt; approve it in **System
Settings** > **Device Management** and enter your login password when asked. The DNS setting
appears under the installed profile. Remove it later from the same screen.

**iPhone:** send the `.mobileconfig` to the device (AirDrop, email attachment, or a file
link) and open it. Then:

1. Open **Settings**. You will see **Profile Downloaded** (or "Enrol in ...").
2. Tap **Profile Downloaded** > **Install** > enter your passcode and follow the prompts.
3. Install within **8 minutes** of downloading. If you do not, iOS deletes the downloaded
   profile automatically and you must download it again.
4. Find the installed profile under **Settings** > **General** > **VPN & Device
   Management**. That is the correct place to inspect it — the profile UI inside a browser is
   unrelated to a configuration profile.
5. If you install while away from a familiar location, iOS may require **Stolen Device
   Protection** to be temporarily disabled, then re-enabled afterwards. Prefer installing
   from a familiar location so you do not need to change it.

Source: [Install a configuration profile on iPhone, iPad or Apple Vision Pro](https://support.apple.com/en-gb/102400).

## Step 14: Test devices and browsers

Use only safe probes. Do not visit real adult sites as the first test.

| Check | Expected |
| --- | --- |
| Allowed control: `example.com` | Loads |
| Custom blocked host: `example.org` | Fails to load |
| Category probe: `pornography.testcategory.com` | Fails to load |
| Private/incognito window | Same results as regular |
| Wi-Fi and cellular | Same results |
| After restart | Blocking persists |

Cover at least Safari and Chrome on iPhone, and Safari plus your other Mac browsers, each in
regular and private mode. New browsers remain unverified until tested. If a browser is
configured to use its own secure DNS provider, bypasses the system resolver, or you have
Private Relay or a VPN active, results can differ — record those conditions with your
results.

A successful policy sync means Gateway has your rules. It is not proof that any device is
filtered; only these checks are, and only for the browsers, networks and conditions you
actually tested.

## Updating an existing deployment

To change settings later (new location, rotated token, new Access app), edit
`wrangler.production.json`, re-run the secret command if the token changed, then redeploy:

```sh
pnpm run build:web
pnpm exec wrangler deploy --config wrangler.production.json --env-file=/dev/null
```

See [`operations.md`](operations.md) for token rotation, failure recovery and day-two
behaviour.

## What this does and does not prove

- Green `pnpm run verify` proves the code and its local runtime tests pass. It does not prove
  your account or devices are configured.
- An idle reconciliation proves Gateway accepted your rules and they read back as intended.
  It does not prove any browser uses the endpoint.
- Only a device test proves a device is filtered, and only for the conditions you tested.
