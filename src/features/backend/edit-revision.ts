/** Keep the version of the displayed edit view; stream updates must not advance a draft's version. */
export function expectedRevision(revision: number | undefined): { expectedRevision?: number } {
  return revision === undefined ? {} : { expectedRevision: revision };
}
