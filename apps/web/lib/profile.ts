/** Display-name rules live in one pure module shared with the server route. */
export {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MESSAGES,
  parseDisplayName,
  type DisplayNameResult,
} from "@stateaction/server/display-name";

export function initialsOf(name: string, email: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  // Initials come from letters/digits only, so "<b>" or emoji never leak in.
  const glyphs = (word: string | undefined): string[] =>
    [...(word ?? "")].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const first = (word: string | undefined): string => glyphs(word)[0] ?? "";
  const letters =
    words.length >= 2
      ? first(words[0]) + first(words[words.length - 1])
      : glyphs(words[0] ?? email)
          .slice(0, 2)
          .join("");
  const fallback = glyphs(email).slice(0, 2).join("");
  return (letters || fallback).toLocaleUpperCase("en-US") || "?";
}
