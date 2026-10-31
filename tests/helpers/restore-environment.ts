/**
 * Remembers `process.env` and returns a function that puts it back. It changes
 * the object in place because, from Node 26, child processes do not see
 * variables set on an object assigned to `process.env`.
 */
export function environmentRestorer(): () => void {
  const environment = { ...process.env };
  return () => {
    for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
    Object.assign(process.env, environment);
  };
}
