import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";

// Local-only: open on localhost for `eve dev` and the REPL.
// Add real auth before exposing this anywhere else.
export default eveChannel({
  auth: [localDev()],
});
