/**
 * Names the Wisp form can suggest, for people who would rather not stop and
 * invent one. Short names in English and Portuguese, most of them about light
 * and small flames, as a will-o'-the-wisp is. Edit the list freely: nothing
 * else depends on its contents.
 */
export const WISP_NAME_SUGGESTIONS: ReadonlyArray<string> = [
  "Ember",
  "Spark",
  "Glimmer",
  "Flicker",
  "Lumen",
  "Glow",
  "Beacon",
  "Halo",
  "Nova",
  "Comet",
  "Aurora",
  "Pixel",
  "Echo",
  "Juniper",
  "Willow",
  "Moss",
  "Pebble",
  "Fern",
  "Orbit",
  "Quill",
  "Sage",
  "Wren",
  "Atlas",
  "Iris",
  "Faísca",
  "Brasa",
  "Lume",
  "Centelha",
  "Chama",
  "Vagalume",
  "Estrela",
  "Lampejo",
  "Brisa",
  "Cometa",
  "Lua",
  "Sol",
  "Orvalho",
  "Pirilampo",
  "Clarão",
];

/**
 * A name from `WISP_NAME_SUGGESTIONS` other than `current`, ignoring case and
 * surrounding spaces, so every press of the button changes the field.
 */
export function suggestWispName(current: string, random: () => number = Math.random): string {
  const taken = current.trim().toLowerCase();
  const choices = WISP_NAME_SUGGESTIONS.filter((name) => name.toLowerCase() !== taken);
  return choices[Math.floor(random() * choices.length)] ?? WISP_NAME_SUGGESTIONS[0]!;
}
