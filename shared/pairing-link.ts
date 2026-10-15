/**
 * The address that pairs a device in one step. The code rides in the fragment,
 * which browsers never send, so it stays out of proxy and access logs.
 */
export function pairingLink(publicOrigin: string, code: string): string {
  return `${new URL(publicOrigin).origin}/#pair=${encodeURIComponent(code)}`;
}
