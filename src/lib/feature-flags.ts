function isEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === "true";
}

const FEATURE_FLAGS = Object.freeze({
  circles: isEnabled(import.meta.env.VITE_FEATURE_CIRCLES),
});

export { FEATURE_FLAGS };
