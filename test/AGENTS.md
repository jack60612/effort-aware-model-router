# Test Instructions

## Source-to-test ownership
- `src/classifier.ts` → `test/classifier.test.ts`
- `src/config.ts` → `test/config.test.ts`
- `src/delegation.ts` → `test/delegation.test.ts`
- `src/extension.ts` → `test/extension.test.ts`
- `src/routing.ts` → `test/routing.test.ts`
- `src/setup.ts` → `test/setup.test.ts`
- `src/state.ts` → `test/state.test.ts`

## Test discipline
- Test observable behavior and update the matching test when a source contract changes.
- Use deterministic seams and test doubles; never require live model credentials or provider calls.
- Run the focused test (`bun test test/<module>.test.ts`) while iterating.
- Before delivery, run `bun test && bun run check`.
