/**
 * @usebruno/lang ships no type declarations, so this is the contract this
 * codebase relies on — deliberately narrow: only the four functions bruno.ts
 * actually calls, typed as what they are rather than as `any`.
 *
 * The shapes are `unknown`-returning on purpose. A .bru file's parsed form is
 * an open structure whose fields depend on the request, and pretending to
 * know it here would put a fiction in the type system; bruno.ts narrows the
 * few fields it reads at the point it reads them.
 */
declare module "@usebruno/lang" {
  const lang: {
    /** Parses a request .bru file into its object form. */
    bruToJsonV2(source: string): unknown;
    /** Serialises that object form back to .bru, byte-identically for an
     *  untouched request — the property bruno.test.ts pins. */
    jsonToBruV2(json: unknown): string;
    /** Parses an environments/*.bru file. */
    bruToEnvJsonV2(source: string): unknown;
    envJsonToBruV2(json: unknown): string;
  };
  export default lang;
}
