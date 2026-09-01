import { createLatestRequestGate } from "./navigation-history.js";

// One authority orders project/global composer transitions, first-message Send,
// and semantic workspace destinations that can occur without a click.
export const projectComposerGate = createLatestRequestGate();
