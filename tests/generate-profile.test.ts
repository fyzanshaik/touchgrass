import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Effect, Either } from "effect";
import type { GenerateDnsProfileError } from "../src/dns-profile/errors.ts";
import { generateDnsProfile } from "../src/dns-profile/generate-profile.ts";

const acceptedEndpoint = "https://clearbrowse-test.cloudflare-gateway.com/dns-query";

const workRoot = await mkdtemp(path.join(tmpdir(), "touchgrass-profile-"));

after(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

const sequentialUuid = (): (() => string) => {
  let counter = 0;
  return () => {
    counter += 1;
    return `uuid-${counter}`;
  };
};

const run = (
  argv: readonly string[],
  nextUuid: () => string = sequentialUuid(),
): Promise<Either.Either<string, GenerateDnsProfileError>> =>
  Effect.runPromise(Effect.either(generateDnsProfile(argv, nextUuid)));

const failureTag = (
  result: Either.Either<string, GenerateDnsProfileError>,
): string | undefined => (Either.isLeft(result) ? result.left._tag : undefined);

describe("generateDnsProfile", () => {
  it("writes a private, removable profile and reports the path", async () => {
    const target = path.join(workRoot, "success.mobileconfig");
    const result = await run([acceptedEndpoint, target]);

    assert.equal(Either.isRight(result), true);
    if (Either.isRight(result)) {
      assert.equal(result.right, target);
    }
    const contents = await readFile(target, "utf8");
    assert.equal(contents.includes(`<string>${acceptedEndpoint}</string>`), true);
    assert.equal(contents.includes("<string>uuid-1</string>"), true);
    assert.equal(contents.includes("<string>uuid-2</string>"), true);
    const { mode } = await stat(target);
    assert.equal(mode & 0o777, 0o600);
  });

  it("refuses to overwrite an existing profile and leaves it unchanged", async () => {
    const target = path.join(workRoot, "exclusive.mobileconfig");
    assert.equal(failureTag(await run([acceptedEndpoint, target])), undefined);
    const before = await readFile(target, "utf8");

    const second = await run([acceptedEndpoint, target]);
    assert.equal(failureTag(second), "OutputExists");
    assert.equal(await readFile(target, "utf8"), before);
  });

  it("rejects a missing or extra argument", async () => {
    assert.equal(failureTag(await run([])), "MissingArguments");
    assert.equal(
      failureTag(await run([acceptedEndpoint, "a.mobileconfig", "extra"])),
      "MissingArguments",
    );
  });

  it("rejects an endpoint that is not a gateway DoH URL", async () => {
    const target = path.join(workRoot, "never-written.mobileconfig");
    assert.equal(failureTag(await run(["https://evil.example/dns-query", target])), "InvalidEndpoint");
    assert.equal(failureTag(await run(["not-a-url", target])), "InvalidEndpoint");
  });

  it("rejects an output path without the mobileconfig extension", async () => {
    assert.equal(
      failureTag(await run([acceptedEndpoint, path.join(workRoot, "profile.txt")])),
      "InvalidOutputPath",
    );
  });

  it("reports a write failure instead of throwing", async () => {
    const target = path.join(workRoot, "missing-directory", "profile.mobileconfig");
    const result = await run([acceptedEndpoint, target]);
    assert.equal(failureTag(result), "OutputWriteFailed");
    if (Either.isLeft(result) && result.left._tag === "OutputWriteFailed") {
      assert.equal(result.left.code, "ENOENT");
      assert.equal(result.left.path, target);
    }
  });
});
