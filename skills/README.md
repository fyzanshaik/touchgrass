# Touchgrass assistant skills

These portable skills help an AI assistant set up Touchgrass, explain its design, and recover
an existing installation. They contain instructions, not credentials or an automatic installer.
They work with the repository's maintained guides and your own Cloudflare account.

| Skill | Use it for |
| --- | --- |
| [touchgrass-setup](touchgrass-setup/SKILL.md) | Local preview, Cloudflare onboarding, deployment, and installing/testing profiles for yourself or your family |
| [touchgrass-understand](touchgrass-understand/SKILL.md) | Product scope, architecture, code walkthroughs, policy behavior, and limitations |
| [touchgrass-recover](touchgrass-recover/SKILL.md) | Missing profiles, browser DNS bypasses, dashboard errors, and Gateway sync failures |

## Use directly from a clone

Open this repository in your assistant and paste a prompt such as:

```text
Read skills/touchgrass-setup/SKILL.md and use it to help me set up Touchgrass
for my family's Macs and iPhones in my own Cloudflare account.
```

```text
Read skills/touchgrass-understand/SKILL.md and explain how DNS filtering,
the dashboard, and cooldowns fit together. Show me the relevant source files.
```

```text
Read skills/touchgrass-recover/SKILL.md and diagnose why blocking stopped
in Chrome. Check the existing deployment before changing anything.
```

This method does not depend on automatic skill discovery. Your assistant needs file access to
the clone; it can guide manual steps if it lacks Cloudflare or device-control tools.

## Register with a skills-capable assistant

Copy one or more `touchgrass-*` directories into the skill location documented by your
assistant. Copy each whole directory, including `SKILL.md` and `agents/` metadata, rather
than merging all skills into one folder. Leave existing skills in place.

Keep a Touchgrass clone available and open it as the working directory. These skills locate
the repository separately, so they also work when registered outside the clone. If your
assistant supports named invocation, use `$touchgrass-setup`, `$touchgrass-understand`, or
`$touchgrass-recover` after registration; otherwise use the direct-file prompts above.
Discovery, registration paths and named invocation vary between assistants. `agents/openai.yaml`
provides optional UI metadata for compatible tools; other assistants can read `SKILL.md`.

The skills do not install themselves, choose your account, transmit files, or grant permission
for deployment. Ask for the action you want. Never paste API tokens or login cookies into chat.
They require no particular MCP connection, provider, paid model or session manager.

## Keep them current

After updating the repository, refresh any copied skill directories too. The detailed setup
and operations procedures live in [the setup guide](../docs/setup.md) and
[the operations guide](../docs/operations.md), so the assistant should read them from your
current clone. The [MIT license](../LICENSE) covers these skills as part of the project.
