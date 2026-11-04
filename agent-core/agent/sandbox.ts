import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// Pure-JavaScript shell with a virtual filesystem: no Docker, no VM, no account.
export const environment = JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
