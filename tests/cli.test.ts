import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const workRoot = await mkdtemp(path.join(tmpdir(), "touchgrass-cli-"));
const acceptedEndpoint = "https://clearbrowse-test.cloudflare-gateway.com/dns-query";

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

const runCli = (
  ...args: readonly string[]
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
  const result = spawnSync("node", ["scripts/generate-dns-profile.ts", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe("generate:dns-profile CLI", () => {
  it("reports the created path and exits 0", () => {
    const target = path.join(workRoot, "cli.mobileconfig");
    const result = runCli(acceptedEndpoint, target);

    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes(target), true);
    assert.equal(result.stdout.includes("No settings were installed or changed."), true);
    assert.equal(result.stderr, "");
  });

  it("prints usage and exits 1 when arguments are missing", () => {
    const result = runCli();

    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("Usage: pnpm run generate:dns-profile"), true);
  });

  it("rejects extra arguments rather than ignoring them", () => {
    const result = runCli(acceptedEndpoint, path.join(workRoot, "extra.mobileconfig"), "extra");

    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("Usage: pnpm run generate:dns-profile"), true);
  });

  it("explains an endpoint that is not a gateway DoH URL and exits 1", () => {
    const result = runCli(
      "https://evil.example/dns-query",
      path.join(workRoot, "rejected.mobileconfig"),
    );

    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("Provide a valid Gateway DoH URL"), true);
  });

  it("explains a missing mobileconfig extension and exits 1", () => {
    const result = runCli(acceptedEndpoint, path.join(workRoot, "rejected.txt"));

    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes(".mobileconfig"), true);
  });

  it("refuses to overwrite an existing profile and exits 1", () => {
    const target = path.join(workRoot, "existing.mobileconfig");
    assert.equal(runCli(acceptedEndpoint, target).status, 0);

    const second = runCli(acceptedEndpoint, target);
    assert.equal(second.status, 1);
    assert.equal(second.stderr.includes("already exists"), true);
  });

  it("reports a write failure with its error code and exits 1", () => {
    const result = runCli(
      acceptedEndpoint,
      path.join(workRoot, "missing-directory", "profile.mobileconfig"),
    );

    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("ENOENT"), true);
  });
});
