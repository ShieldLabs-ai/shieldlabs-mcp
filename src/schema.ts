import { z } from 'zod';

// Nullable fields are declared as a union with a described branch so that the JSON Schema sent to
// clients uses anyOf with single types, which more clients understand than a type array.

/** A string or null. */
export function nullableString(description: string) {
  return z.union([z.string().describe(description), z.null()]);
}

/** A number or null. */
export function nullableNumber(description: string) {
  return z.union([z.number().describe(description), z.null()]);
}
