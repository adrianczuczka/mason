/** Narrow external objects without allowing arrays or null to masquerade as records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
