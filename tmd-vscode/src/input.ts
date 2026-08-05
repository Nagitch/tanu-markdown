/** Delay only expensive preview rendering; edits are posted immediately. */
export const PREVIEW_DEBOUNCE_MS = 150;

export interface RevisionedHostMessage {
  clientRevision: number;
  contentRevision: number;
}

/**
 * Browser-side revision gate shared by every TMD editor surface.
 *
 * This class deliberately has no VS Code dependency. The bundled web app and
 * a future browser host can use the same ordering rules while the authoritative
 * document state remains in the shared session behind the host bridge.
 */
export class EditorClientState {
  private initializedValue = false;
  private clientRevisionValue = 0;
  private acknowledgedContentRevisionValue = -1;

  get initialized(): boolean {
    return this.initializedValue;
  }

  get clientRevision(): number {
    return this.clientRevisionValue;
  }

  nextEditRevision(): number | undefined {
    if (!this.initializedValue) {
      return undefined;
    }
    this.clientRevisionValue += 1;
    return this.clientRevisionValue;
  }

  acceptEditAcknowledgement(message: RevisionedHostMessage): boolean {
    if (
      !validRevision(message.clientRevision) ||
      !validRevision(message.contentRevision) ||
      message.clientRevision > this.clientRevisionValue
    ) {
      return false;
    }
    this.acknowledgedContentRevisionValue = Math.max(
      this.acknowledgedContentRevisionValue,
      message.contentRevision,
    );
    return true;
  }

  acceptPreview(message: RevisionedHostMessage): boolean {
    return (
      validRevision(message.clientRevision) &&
      validRevision(message.contentRevision) &&
      message.clientRevision === this.clientRevisionValue &&
      message.contentRevision >= this.acknowledgedContentRevisionValue
    );
  }

  acceptAuthoritativeState(message: RevisionedHostMessage): boolean {
    if (
      !validRevision(message.clientRevision) ||
      !validRevision(message.contentRevision) ||
      message.clientRevision !== this.clientRevisionValue ||
      message.contentRevision < this.acknowledgedContentRevisionValue
    ) {
      return false;
    }
    this.acknowledgedContentRevisionValue = message.contentRevision;
    this.initializedValue = true;
    return true;
  }
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
