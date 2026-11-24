/**
 * Human labels for permission codes shown to users (approval stages, the MFA-gated list on
 * /account/security). Strings live in messages/<locale>/permissions.json under `label`, keyed by
 * the code with dots replaced by underscores; an unknown code falls back to the code itself.
 */
export function permissionLabelKey(code: string): string {
  return `label.${code.replaceAll(".", "_")}`;
}

type Translator = { (key: string): string; has(key: string): boolean };

export function permissionLabel(t: Translator, code: string): string {
  const key = permissionLabelKey(code);
  return t.has(key) ? t(key) : code;
}
