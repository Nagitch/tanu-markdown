export interface RevisionedSnapshot<State> {
  contentRevision: number;
  state: State;
}

/**
 * Render and publish a revisioned snapshot without dropping a newer revision.
 *
 * Rendering and delivery may both yield to incoming edits. A stale render is
 * discarded, while an edit that arrives during delivery schedules another
 * pass so callers eventually publish the latest stable state.
 */
export async function publishLatestRevision<State, Rendered>(
  capture: () => RevisionedSnapshot<State>,
  currentRevision: () => number,
  render: (state: State) => Promise<Rendered>,
  publish: (
    snapshot: RevisionedSnapshot<State>,
    rendered: Rendered,
  ) => Promise<void>,
): Promise<void> {
  for (;;) {
    const snapshot = capture();
    const rendered = await render(snapshot.state);
    if (snapshot.contentRevision !== currentRevision()) {
      continue;
    }
    await publish(snapshot, rendered);
    if (snapshot.contentRevision === currentRevision()) {
      return;
    }
  }
}
