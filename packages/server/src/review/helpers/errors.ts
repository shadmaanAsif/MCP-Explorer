// Small things every review module shares.

// Thrown for bad input. Tools turn it into an isError result; resource reads
// turn it into a protocol error.
export class ReviewError extends Error {}

export function truncate(text: string, limit: number, what: string): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[${what} truncated at ${limit} characters]`;
}
