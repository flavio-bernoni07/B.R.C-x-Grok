import { redirect } from "next/navigation";

/** Disputes live in Actions now (ops workspace). Keep this path so old links still land. */
export default function Page() {
  redirect("/actions");
}
