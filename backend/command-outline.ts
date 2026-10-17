/**
 * The programs a shell command runs, without their arguments: `cd app && npm
 * run build | tail` becomes `cd · npm run build · tail`. Paths, URLs, values
 * and quoted text are left out, so the outline can be shown where the command
 * itself would be private.
 */
export function outlineCommand(command: string, maxLength = MAX_OUTLINE_CHARACTERS): string {
  const steps: string[] = [];
  for (const segment of splitSegments(command)) {
    const step = outlineSegment(segment);
    if (step && steps.at(-1) !== step) steps.push(step);
  }
  const outline = steps.join(" · ");
  return outline.length <= maxLength ? outline : `${outline.slice(0, maxLength)}…`;
}

const MAX_OUTLINE_CHARACTERS = 200;
/** Programs whose first argument names what they do (`git clone`, `npm install`). */
const SUBCOMMAND_PROGRAMS = new Set([
  "apt",
  "apt-get",
  "bun",
  "cargo",
  "corepack",
  "deno",
  "docker",
  "dotnet",
  "gh",
  "git",
  "go",
  "gradle",
  "kubectl",
  "make",
  "mvn",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pnpm",
  "podman",
  "poetry",
  "uv",
  "yarn",
]);
/** Subcommands that run something else named by the next argument (`npm run build`). */
const RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "run", "run-script", "x"]);
/** Prefixes that run the program after them. */
const WRAPPERS = new Set(["command", "env", "exec", "nice", "nohup", "sudo", "time", "timeout"]);
const PROGRAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const WORD_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,39}$/i;
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SECRET_PATTERN = /sk-|key[=_-]|token|secret|bearer|passw/i;

function outlineSegment(segment: string[]): string {
  let index = 0;
  while (index < segment.length && (ASSIGNMENT_PATTERN.test(segment[index]!) || WRAPPERS.has(segment[index]!))) {
    // `timeout 30 npm test`: the duration is not the program.
    if (segment[index] === "timeout" && /^\d/.test(segment[index + 1] ?? "")) index += 1;
    index += 1;
  }
  const first = segment[index];
  if (!first) return "";
  const program = first.slice(first.lastIndexOf("/") + 1);
  if (!PROGRAM_PATTERN.test(program) || SECRET_PATTERN.test(program)) return "";
  const words = [program];
  if (SUBCOMMAND_PROGRAMS.has(program)) {
    const subcommand = safeWord(segment[index + 1]);
    if (subcommand) {
      words.push(subcommand);
      const target = RUNNER_SUBCOMMANDS.has(subcommand) ? safeWord(segment[index + 2]) : "";
      if (target) words.push(target);
    }
  }
  return words.join(" ");
}

function safeWord(token: string | undefined): string {
  return token && WORD_PATTERN.test(token) && !SECRET_PATTERN.test(token) ? token : "";
}

/**
 * Splits a command into the words of each simple command, at `;`, `&&`,
 * `||`, `|`, `&`, parentheses and newlines outside quotes. Quoted text becomes a word that
 * never passes the word patterns, so it is never shown.
 */
function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"') index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      // Marks the word as quoted, so it fails the word patterns.
      word += character;
    } else if (character === "\\") {
      index += 1;
    } else if ((character === "<" || character === ">") && command[index + 1] === "&") {
      // `2>&1` duplicates a descriptor; it does not start a command.
      word += "\u0000";
      index += 1;
    } else if (character === "&" && command[index + 1] === ">") {
      word += "\u0000";
    } else if (";&|()\n".includes(character)) {
      endSegment();
    } else if (/\s/.test(character)) {
      endWord();
    } else if ("<>`$".includes(character)) {
      // Redirections and expansions: what follows is not a program name.
      word += "\u0000";
    } else {
      word += character;
    }
  }
  endSegment();
  return segments;
}
