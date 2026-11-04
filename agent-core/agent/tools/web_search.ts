import { disableTool } from "eve/tools";

// eve's built-in web_search doesn't support direct xAI models; rice_market_news uses
// Grok's own web and X search instead.
export default disableTool();
