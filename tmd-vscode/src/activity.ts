export interface ActivityPanel {
  readonly active: boolean;
}

export function findActiveDocument<Document, Panel extends ActivityPanel>(
  panelsByDocument: ReadonlyMap<Document, ReadonlySet<Panel>>,
): Document | undefined {
  for (const [document, panels] of panelsByDocument) {
    if ([...panels].some((panel) => panel.active)) {
      return document;
    }
  }
  return undefined;
}
