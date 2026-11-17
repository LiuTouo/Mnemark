// Pure close-guard decision for the settings window. Every close path
// (Escape, Cancel, title-bar X via the backend CloseRequested event) funnels
// through here, so the dirty guard cannot be bypassed by one path.

export interface CloseGuardState {
  saving: boolean;
  /** True only when a loaded config differs from the form. */
  dirty: boolean;
  /** A previous close attempt on a dirty form already asked for confirmation. */
  armed: boolean;
}

export type CloseIntent =
  /** Hide the window now. */
  | "hide"
  /** Ask the user to confirm discarding unsaved changes. */
  | "arm"
  /** Swallow the close attempt entirely (a save is in flight). */
  | "ignore";

export function resolveCloseIntent(state: CloseGuardState): CloseIntent {
  if (state.saving) return "ignore";
  return state.armed || !state.dirty ? "hide" : "arm";
}
