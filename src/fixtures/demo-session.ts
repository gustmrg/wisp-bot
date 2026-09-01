import type { CurrentUser } from "@/config/app-metadata";

const DEMO_CURRENT_USER = Object.freeze({
  displayName: "John Doe",
  email: "john.doe@example.com",
  givenName: "John",
  initials: "JD",
}) satisfies CurrentUser;

export { DEMO_CURRENT_USER };
