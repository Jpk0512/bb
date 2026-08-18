export function validateOptionalUrl(name: string, value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return "";
  }
  return validateRequiredUrl(name, trimmedValue);
}

/**
 * Parses a comma-separated list of browser origins. Each entry must be a URL
 * whose origin is the whole value, so a path, query, or credentials are
 * rejected rather than silently ignored: an allowlist entry that does not mean
 * what it says is a security defect, not a convenience.
 */
export function validateOriginList(
  name: string,
  value: string,
): readonly string[] {
  const origins: string[] = [];
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      continue;
    }

    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${name} entries must be valid URLs, received "${entry}"`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${name} entries must be http or https, received "${entry}"`);
    }
    if (url.origin !== entry.replace(/\/+$/u, "")) {
      throw new Error(
        `${name} entries must be bare origins such as https://host, received "${entry}"`,
      );
    }
    if (!origins.includes(url.origin)) {
      origins.push(url.origin);
    }
  }
  return origins;
}

export function validateRequiredUrl(name: string, value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    throw new Error(`${name} must not be empty`);
  }

  try {
    void new URL(trimmedValue);
    return trimmedValue;
  } catch {
    throw new Error(`${name} must be a valid URL, received "${value}"`);
  }
}
