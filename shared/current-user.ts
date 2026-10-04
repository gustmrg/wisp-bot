export interface CurrentUser {
  readonly displayName: string;
  readonly givenName: string;
  readonly initials: string;
}

export const DEMO_CURRENT_USER = Object.freeze({
  displayName: "John Doe",
  givenName: "John",
  initials: "JD",
}) satisfies CurrentUser;
