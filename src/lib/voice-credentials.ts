type Listener = () => void;

const listeners = new Set<Listener>();

/** Tells voice input to check its provider key again, after a key was saved or removed in Settings. */
export function notifyProviderCredentialsChanged(): void {
  for (const listener of listeners) listener();
}

export function subscribeToProviderCredentials(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
