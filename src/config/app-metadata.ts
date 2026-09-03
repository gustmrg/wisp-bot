interface CurrentUser {
  readonly displayName: string;
  readonly email: string;
  readonly givenName: string;
  readonly initials: string;
}

interface AppMetadata {
  readonly displayName: string;
  readonly packageName: string;
  readonly version: string;
}

function packageDisplayName(packageName: string): string {
  return packageName
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ");
}

// A future packaged-app preload boundary may replace the build-time version with app.getVersion().
const APP_METADATA = Object.freeze({
  displayName: packageDisplayName(__APP_PACKAGE_NAME__),
  packageName: __APP_PACKAGE_NAME__,
  version: __APP_VERSION__,
}) satisfies AppMetadata;

export { APP_METADATA, packageDisplayName };
export type { AppMetadata, CurrentUser };
