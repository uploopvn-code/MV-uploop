// Shared UI state that several features read and change (the project state from the
// server, the inspected node, unsaved-edit flag…). One object, so every module sees the same values.
export const store = {
  state: undefined,
  selected: null,
  dirty: false,
};
