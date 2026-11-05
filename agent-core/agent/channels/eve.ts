import { eveChannel } from "eve/channels/eve";
import { type AuthFn, localDev } from "eve/channels/auth";

// The hosted demo runs on synthetic data: the dashboard's own pages may talk to the agent, other
// websites may not. Browsers set Sec-Fetch-Site themselves; a page's script can't change it.
const dashboard: AuthFn<Request> = (request) =>
  request.headers.get("sec-fetch-site") === "same-origin"
    ? { authenticator: "dashboard", principalId: "dashboard", principalType: "user", attributes: {} }
    : null;

// localDev() first, so the local app and the Mac window keep their local-dev sessions.
export default eveChannel({
  auth: [localDev(), dashboard],
});
