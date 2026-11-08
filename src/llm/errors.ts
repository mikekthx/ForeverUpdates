/** Classifies model failures so the caller knows how long to stop calling that model. */
export class LlmError extends Error {
  constructor(message: string, readonly kind: "daily-quota" | "rate-limit" | "overloaded" | "other") { super(message); }
}
