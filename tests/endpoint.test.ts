import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Either, ParseResult, Schema } from "effect";
import {
  GatewayEndpoint,
  OutputPath,
  endpointMessage,
  outputPathMessage,
} from "../src/dns-profile/endpoint.ts";

const decodeEndpoint = Schema.decodeUnknownEither(GatewayEndpoint);
const decodeOutputPath = Schema.decodeUnknownEither(OutputPath);

const describeIssue = (issue: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(issue);

const acceptedEndpoint = "https://clearbrowse-test.cloudflare-gateway.com/dns-query";

const rejectedEndpoints = [
  "",
  "clearbrowse-test.cloudflare-gateway.com/dns-query",
  "http://clearbrowse-test.cloudflare-gateway.com/dns-query",
  "https://clearbrowse-test.cloudflare-gateway.com:8443/dns-query",
  "https://user:secret@clearbrowse-test.cloudflare-gateway.com/dns-query",
  "https://clearbrowse-test.cloudflare-gateway.com/dns-query?name=example.org",
  "https://clearbrowse-test.cloudflare-gateway.com/dns-query#fragment",
  "https://clearbrowse-test.cloudflare-gateway.com/",
  "https://clearbrowse-test.cloudflare-gateway.com/dns-query/",
  "https://clearbrowse-test.cloudflare-gateway.com.evil.example/dns-query",
  "https://evil.example/dns-query",
  "https://cloudflare-gateway.com/dns-query",
  "https://clearbrowse_test.cloudflare-gateway.com/dns-query",
  "https://-leading.cloudflare-gateway.com/dns-query",
  "https://trailing-.cloudflare-gateway.com/dns-query",
] as const;

describe("GatewayEndpoint", () => {
  it("accepts a gateway DoH endpoint", () => {
    const result = decodeEndpoint(acceptedEndpoint);
    assert.equal(Either.isRight(result), true);
    if (Either.isRight(result)) {
      assert.equal(result.right, acceptedEndpoint);
    }
  });

  it("normalizes scheme, host casing and surrounding whitespace", () => {
    const result = decodeEndpoint(
      "  HTTPS://ClearBrowse-Test.Cloudflare-Gateway.COM/dns-query  ",
    );
    assert.equal(Either.isRight(result), true);
    if (Either.isRight(result)) {
      assert.equal(result.right, acceptedEndpoint);
    }
  });

  it("accepts an endpoint that relies on the default https port", () => {
    const result = decodeEndpoint(
      "https://clearbrowse-test.cloudflare-gateway.com:443/dns-query",
    );
    assert.equal(Either.isRight(result), true);
  });

  for (const endpoint of rejectedEndpoints) {
    it(`rejects ${JSON.stringify(endpoint)}`, () => {
      const result = decodeEndpoint(endpoint);
      assert.equal(Either.isLeft(result), true);
      if (Either.isLeft(result)) {
        assert.equal(describeIssue(result.left).includes(endpointMessage), true);
      }
    });
  }
});

describe("OutputPath", () => {
  it("accepts a path ending in the mobileconfig extension", () => {
    assert.equal(
      Either.isRight(decodeOutputPath("generated/clearbrowse-test.mobileconfig")),
      true,
    );
    assert.equal(Either.isRight(decodeOutputPath("clearbrowse-test.mobileconfig")), true);
  });

  for (const outputPath of [
    "",
    "clearbrowse-test",
    "clearbrowse-test.MOBILECONFIG",
    "clearbrowse-test.mobileconfig.bak",
  ]) {
    it(`rejects ${JSON.stringify(outputPath)}`, () => {
      const result = decodeOutputPath(outputPath);
      assert.equal(Either.isLeft(result), true);
      if (Either.isLeft(result)) {
        assert.equal(describeIssue(result.left), outputPathMessage);
      }
    });
  }
});

describe("GatewayEndpoint malformed input", () => {
  const malformedInputs: readonly unknown[] = [
    123,
    null,
    undefined,
    {},
    [],
    true,
    "https://",
    "https://[",
  ];

  for (const input of malformedInputs) {
    it(`fails without a defect for ${JSON.stringify(input)}`, async () => {
      const outcome = await Effect.runPromise(
        Effect.either(Schema.decodeUnknown(GatewayEndpoint)(input)),
      );
      assert.equal(Either.isLeft(outcome), true);
    });
  }
});
