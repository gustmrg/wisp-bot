export interface CurrentUser {
  readonly displayName: string;
  readonly email: string;
  readonly givenName: string;
  readonly initials: string;
}

export const DEMO_CURRENT_USER = Object.freeze({
  displayName: "John Doe",
  email: "john.doe@example.com",
  givenName: "John",
  initials: "JD",
}) satisfies CurrentUser;
