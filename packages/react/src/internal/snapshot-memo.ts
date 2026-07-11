/**
 * Memoises a derived snapshot for `useSyncExternalStore`. It re-runs `select` when the raw input
 * changes by identity **or** when the `select`/`isEqual` identity changes — so a selector that
 * closes over render scope reflects the latest props on the next render, matching React's
 * `useSyncExternalStoreWithSelector` semantics — and hands back the previous reference whenever the
 * selected value is `isEqual`, letting React skip the re-render. The value stays stable within a
 * single render (no tearing / render loop) because the render inputs are constant across the
 * repeated `getSnapshot` calls React makes in one commit. All state is `#private`:
 * runtime-encapsulated, and testable in isolation.
 */
export class SnapshotMemo<Out> {
  #has = false;
  #input: unknown = undefined;
  #select: ((input: unknown) => Out) | undefined = undefined;
  #isEqual: ((a: Out, b: Out) => boolean) | undefined = undefined;
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
    // Short-circuit only when nothing that feeds the projection has changed: same raw input AND the
    // same `select`/`isEqual` identity. A new selector (e.g. one closing over changed props) must
    // recompute even if the raw store value is untouched — otherwise it returns a stale slice.
    const selectorStable = this.#select === select && this.#isEqual === isEqual;
    if (this.#has && selectorStable && Object.is(this.#input, input)) return this.#output;
    const next = select ? select(input) : (input as Out);
    this.#select = select;
    this.#isEqual = isEqual;
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
