import { Container } from "@cloudflare/containers";

export interface Env {
  DASHBOARD: DurableObjectNamespace<Dashboard>;
  XAI_API_KEY?: string;
}

/** One dashboard server. It sleeps when nobody is using it and wakes on the next visit. */
export class Dashboard extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "30m";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (env.XAI_API_KEY) this.envVars = { XAI_API_KEY: env.XAI_API_KEY };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.DASHBOARD.getByName("brc").fetch(request);
  },
};
