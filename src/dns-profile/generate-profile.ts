import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Effect, ParseResult, Schema } from "effect";
import {
  GatewayEndpoint,
  OutputPath,
} from "./endpoint.ts";
import {
  InvalidEndpoint,
  InvalidOutputPath,
  MissingArguments,
  OutputExists,
  OutputWriteFailed,
  type GenerateDnsProfileError,
} from "./errors.ts";
import { buildDnsProfileXml, defaultProfileMetadata } from "./profile.ts";

export const usage =
  "Usage: pnpm run generate:dns-profile <Gateway DoH URL> <output.mobileconfig>";

const decodeEndpoint = Schema.decodeUnknown(GatewayEndpoint);
const decodeOutputPath = Schema.decodeUnknown(OutputPath);

const describeIssue = (issue: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(issue);

const hasStringCode = (cause: unknown): cause is { code: string } =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string";

const readErrorCode = (cause: unknown): string =>
  hasStringCode(cause) ? cause.code : "UNKNOWN";

const writeExclusive = (
  path: string,
  contents: string,
): Effect.Effect<void, OutputExists | OutputWriteFailed> =>
  Effect.tryPromise({
    try: () => writeFile(path, contents, { flag: "wx", mode: 0o600 }),
    catch: (cause) => {
      const code = readErrorCode(cause);
      return code === "EEXIST"
        ? new OutputExists({ path })
        : new OutputWriteFailed({ path, code });
    },
  });

export const generateDnsProfile = (
  argv: readonly string[],
  nextUuid: () => string = randomUUID,
): Effect.Effect<string, GenerateDnsProfileError> =>
  Effect.gen(function* () {
    if (argv.length !== 2) {
      return yield* Effect.fail(new MissingArguments({ usage }));
    }
    const endpoint = yield* decodeEndpoint(argv[0]).pipe(
      Effect.mapError((issue) => new InvalidEndpoint({ detail: describeIssue(issue) })),
    );
    const outputPath = yield* decodeOutputPath(argv[1]).pipe(
      Effect.mapError(
        (issue) => new InvalidOutputPath({ detail: describeIssue(issue) }),
      ),
    );
    const xml = buildDnsProfileXml({
      endpoint,
      ids: { profileUuid: nextUuid(), dnsSettingsUuid: nextUuid() },
      metadata: defaultProfileMetadata,
    });
    yield* writeExclusive(outputPath, xml);
    return outputPath;
  });
