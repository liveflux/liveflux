/**
 * Memoises a derived snapshot for `useSyncExternalStore`. It re-runs `select` only when the raw
 * input changes by identity — so the value is stable within a render (no tearing / render loop) —
 * and hands back the previous reference whenever the selected value is `isEqual`, letting React
 * skip the re-render. All state is `#private`: runtime-encapsulated, and testable in isolation.
 */
export class SnapshotMemo<Out> {
  #has = false;
  #input: unknown = undefined;
  #output!: Out;

  /**
   * @param input   The raw store state (cached by identity).
   * @param select  Optional projection to a derived value; omitted → the input passes through.
   * @param isEqual Equality for the selected value; equal → the previous reference is kept.
   */
  read(
    input: unknown,
    select: ((input: unknown) => Out) | undefined,
    isEqual: (a: Out, b: Out) => boolean,
  ): Out {
    if (this.#has && Object.is(this.#input, input)) return this.#output;
    const next = select ? select(input) : (input as Out);
    if (this.#has && isEqual(this.#output, next)) {
      this.#input = input; // input advanced but the selected value is unchanged → keep stable ref
      return this.#output;
    }
    this.#input = input;
    this.#output = next;
    this.#has = true;
    return next;
  }
}
