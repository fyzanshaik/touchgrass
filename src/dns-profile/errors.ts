import { Data } from "effect";

export class MissingArguments extends Data.TaggedError("MissingArguments")<{
  readonly usage: string;
}> {}

export class InvalidEndpoint extends Data.TaggedError("InvalidEndpoint")<{
  readonly detail: string;
}> {}

export class InvalidOutputPath extends Data.TaggedError("InvalidOutputPath")<{
  readonly detail: string;
}> {}

export class OutputExists extends Data.TaggedError("OutputExists")<{
  readonly path: string;
}> {}

export class OutputWriteFailed extends Data.TaggedError("OutputWriteFailed")<{
  readonly path: string;
  readonly code: string;
}> {}

export type GenerateDnsProfileError =
  | MissingArguments
  | InvalidEndpoint
  | InvalidOutputPath
  | OutputExists
  | OutputWriteFailed;
