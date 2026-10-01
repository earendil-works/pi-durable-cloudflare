export const MAX_USERNAME_CHARACTERS = 40;

export function normalizeUsername(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[\[\]]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, MAX_USERNAME_CHARACTERS).join("");
}
