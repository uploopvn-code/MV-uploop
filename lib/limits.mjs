// Project-size limits, in one place so the importer and the "add node" route can never drift.
//
// A project is one file (project.json) held in memory and polled whole by the browser, so the
// cap is a guard against a project getting too heavy to work in — not a structural limit.
// Nothing in the data model, the canvas or the runner assumes a particular number.
//
// 400 is sized for a single feature-length segment: a 15-minute film at the dialogue-heavy
// density of a real project here (51 working nodes per 120 seconds) needs ~385 nodes, so it
// fits in one project with its own timeline instead of being split across projects that the
// tool cannot assemble together.
export const NODE_CAP = 400;
// Past this, say so on the canvas: there is still room, but it is worth knowing before
// planning another fifty shots.
export const NODE_WARN = 250;
