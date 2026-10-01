import { normalizeUsername } from "../identity.ts";

export { MAX_USERNAME_CHARACTERS } from "../identity.ts";

const USERNAME_STORAGE_KEY = "pi-durable.username";

export function loadUsername(): string | undefined {
  try {
    const stored = normalizeUsername(window.localStorage.getItem(USERNAME_STORAGE_KEY) ?? "");
    return stored || undefined;
  } catch {
    return undefined;
  }
}

export function saveUsername(value: string): string {
  const username = normalizeUsername(value);
  if (username.length === 0) throw new Error("Enter a display name");
  try {
    window.localStorage.setItem(USERNAME_STORAGE_KEY, username);
  } catch {
    return username;
  }
  return username;
}
