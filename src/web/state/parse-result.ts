export type ParseResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };
