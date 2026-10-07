/**
 * Keyboard shortcuts are stored as "+"-joined modifiers followed by a
 * `KeyboardEvent.code`, such as "Ctrl+Space" or "Ctrl+Shift+KeyM". Codes name
 * physical keys, so a shortcut keeps working across keyboard layouts.
 */
export type ShortcutId = "voiceInput";

export type ShortcutPreferences = Record<ShortcutId, string>;

export const DEFAULT_SHORTCUTS: ShortcutPreferences = { voiceInput: "Ctrl+Space" };

export const SHORTCUT_LABELS: Record<ShortcutId, string> = { voiceInput: "Start or stop voice input" };

/** Opens the schedule menu from the composer: ⌘⇧Enter on Apple keyboards, Ctrl+Shift+Enter elsewhere. */
export const SCHEDULE_SEND_SHORTCUT = isApplePlatform() ? "Meta+Shift+Enter" : "Ctrl+Shift+Enter";

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Shortcuts the app already handles; a custom shortcut may not take them over. */
const RESERVED_SHORTCUTS: ReadonlyArray<{ shortcut: string; label: string }> = [
  { shortcut: "Ctrl+KeyK", label: "Search" },
  { shortcut: "Meta+KeyK", label: "Search" },
  { shortcut: "Ctrl+Shift+Enter", label: "Schedule message" },
  { shortcut: "Meta+Shift+Enter", label: "Schedule message" },
];

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
const KEY_CODE =
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Backspace|Tab|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete)$/;

interface ParsedShortcut {
  modifiers: ReadonlySet<Modifier>;
  code: string;
}

type ShortcutEvent = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

function parseShortcut(value: string): ParsedShortcut | null {
  const parts = value.split("+");
  const code = parts.pop();
  if (!code || !KEY_CODE.test(code)) return null;
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    if (!MODIFIERS.includes(part as Modifier) || modifiers.has(part as Modifier)) return null;
    modifiers.add(part as Modifier);
  }
  // Without Ctrl, Alt, or Meta a shortcut would swallow ordinary typing.
  const usable = modifiers.has("Ctrl") || modifiers.has("Alt") || modifiers.has("Meta") || FUNCTION_KEY.test(code);
  return usable ? { modifiers, code } : null;
}

export function isValidShortcut(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && parseShortcut(value) !== null;
}

export function normalizeShortcuts(value: unknown): ShortcutPreferences {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    voiceInput: isValidShortcut(saved.voiceInput) ? saved.voiceInput : DEFAULT_SHORTCUTS.voiceInput,
  };
}

function eventModifiers(event: ShortcutEvent): Modifier[] {
  return MODIFIERS.filter(
    (modifier) =>
      (modifier === "Ctrl" && event.ctrlKey) ||
      (modifier === "Alt" && event.altKey) ||
      (modifier === "Shift" && event.shiftKey) ||
      (modifier === "Meta" && event.metaKey),
  );
}

/**
 * The shortcut a key press describes, or null while only modifiers are held or
 * when the combination is not usable as a shortcut.
 */
export function shortcutFromEvent(event: ShortcutEvent): string | null {
  if (MODIFIER_CODES.has(event.code)) return null;
  const shortcut = [...eventModifiers(event), event.code].join("+");
  return isValidShortcut(shortcut) ? shortcut : null;
}

export function matchesShortcut(event: ShortcutEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed || event.code !== parsed.code) return false;
  const pressed = eventModifiers(event);
  return pressed.length === parsed.modifiers.size && pressed.every((modifier) => parsed.modifiers.has(modifier));
}

/** The app feature that already uses a shortcut, if any. */
export function reservedShortcutLabel(shortcut: string): string | undefined {
  return RESERVED_SHORTCUTS.find((reserved) => reserved.shortcut === shortcut)?.label;
}

function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return { Up: "↑", Down: "↓", Left: "←", Right: "→" }[code.slice(5)] ?? code;
  return (
    {
      Backquote: "`",
      Minus: "-",
      Equal: "=",
      BracketLeft: "[",
      BracketRight: "]",
      Backslash: "\\",
      Semicolon: ";",
      Quote: "'",
      Comma: ",",
      Period: ".",
      Slash: "/",
    }[code] ?? code
  );
}

/** The keys of a shortcut as they are labeled on this platform's keyboards. */
export function shortcutKeys(shortcut: string, apple = isApplePlatform()): string[] {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return [];
  const names: Record<Modifier, string> = apple
    ? { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }
    : { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Super" };
  return [
    ...MODIFIERS.filter((modifier) => parsed.modifiers.has(modifier)).map((m) => names[m]),
    keyLabel(parsed.code),
  ];
}

export function formatShortcut(shortcut: string, apple = isApplePlatform()): string {
  return shortcutKeys(shortcut, apple).join(apple ? "" : "+");
}
