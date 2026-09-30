import { Effect } from "effect";
import type { GenerateDnsProfileError } from "../src/dns-profile/errors.ts";
import { generateDnsProfile } from "../src/dns-profile/generate-profile.ts";

const messageFor = (error: GenerateDnsProfileError): string => {
  switch (error._tag) {
    case "MissingArguments":
      return error.usage;
    case "InvalidEndpoint":
      return error.detail;
    case "InvalidOutputPath":
      return error.detail;
    case "OutputExists":
      return `Output already exists at ${error.path}. Choose a new path or explicitly remove the old generated file.`;
    case "OutputWriteFailed":
      return `Could not write profile to ${error.path} (${error.code}).`;
  }
};

const program = Effect.match(generateDnsProfile(process.argv.slice(2)), {
  onFailure: (error) => {
    console.error(messageFor(error));
    return 1;
  },
  onSuccess: (path) => {
    console.log(`Created ${path}. No settings were installed or changed.`);
    return 0;
  },
});

process.exitCode = await Effect.runPromise(program);
