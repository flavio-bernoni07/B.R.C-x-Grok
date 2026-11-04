import { xai } from "@ai-sdk/xai";
import { defineAgent } from "eve";

// Grok, called directly through xAI (no Vercel AI Gateway, no account).
// @ai-sdk/xai reads XAI_API_KEY from the environment (.env.local in dev).
// Override the model with GROK_MODEL, e.g. GROK_MODEL=grok-latest.
const modelId = process.env.GROK_MODEL ?? "grok-4.7";

export default defineAgent({
  model: xai.responses(modelId),
  // Low keeps turns fast; the heavy lifting is in the tools.
  reasoning: "low",
  // Not in the AI Gateway catalog, so eve needs the window to plan compaction.
  modelContextWindowTokens: 256_000,
});
