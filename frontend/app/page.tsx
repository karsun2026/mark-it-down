/**
 * Entry point, gated (§43).
 *
 * A server component so the session is checked BEFORE any of the tool renders.
 * The check cannot live in middleware: Edge Runtime is unsupported in a
 * multi-service project, which this must be to run the converter container.
 * See `lib/guard.ts`.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import ConverterApp from "@/components/ConverterApp";
import { SESSION_COOKIE, configuredPassword, isValidSession } from "@/lib/session";

// The gate depends on a per-request cookie, so this page cannot be static.
export const dynamic = "force-dynamic";

export default async function Page() {
  if (configuredPassword()) {
    const store = await cookies();
    if (!(await isValidSession(store.get(SESSION_COOKIE)?.value))) {
      redirect("/login");
    }
  }
  return <ConverterApp />;
}
