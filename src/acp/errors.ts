function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function jsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  if (!isRecord(error)) {
    return String(error);
  }

  const data = isRecord(error.data) ? error.data : undefined;
  const nestedError = isRecord(data?.error) ? data.error : undefined;
  const message = firstNonEmptyString(
    data?.message,
    nestedError?.message,
    data?.details,
    error.message,
  );

  const parts: string[] = [message ?? jsonStringify(error) ?? String(error)];
  const code = firstNonEmptyString(data?.codex_error_info, data?.code, error.code);
  if (code && !parts[0].includes(code)) {
    parts.push(code);
  }

  return parts.join(" (") + (parts.length > 1 ? ")" : "");
}
