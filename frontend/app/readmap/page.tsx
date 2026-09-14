/**
 * The READMAP page, gated exactly like the converter page (§43).
 *
 * A server component so the session is checked BEFORE anything renders;
 * see `lib/guard.ts` for why this cannot live in middleware.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import ReadmapApp from "@/components/readmap/ReadmapApp";
import { SESSION_COOKIE, configuredPassword, isValidSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ReadmapPage() {
  if (configuredPassword()) {
    const store = await cookies();
    if (!(await isValidSession(store.get(SESSION_COOKIE)?.value))) {
      redirect("/login");
    }
  }
  return <ReadmapApp />;
}