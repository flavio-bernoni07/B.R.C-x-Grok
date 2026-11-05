/**
 * Remove phone-channel DSP-… claims (and their sign-offs / notifications) so a filmed
 * call is the only Phone badge on Disputes. Leaves email CLM-… rows alone.
 */
import { eq } from "drizzle-orm";
import type { Erp } from "../core/erp";
import * as s from "../db/schema";

function isPhoneClaim(extraction: unknown): boolean {
  if (!extraction || typeof extraction !== "object") return false;
  const portal = (extraction as { portal?: { channel?: string } }).portal;
  return portal?.channel === "phone";
}

export function clearPhoneClaims(erp: Erp): { removed: string[] } {
  const removed: string[] = [];
  erp.tx(() => {
    for (const c of erp.claims()) {
      if (!isPhoneClaim(c.extraction)) continue;
      erp.db.delete(s.signoffs).where(eq(s.signoffs.subjectRef, c.claimId)).run();
      erp.db.delete(s.notifications).where(eq(s.notifications.subjectRef, c.claimId)).run();
      if (c.sourceDoc) {
        erp.db.delete(s.documents).where(eq(s.documents.docId, c.sourceDoc)).run();
      }
      erp.db.delete(s.claims).where(eq(s.claims.claimId, c.claimId)).run();
      removed.push(c.claimId);
    }
    // Drop phone rehearsal conversations so intake starts clean.
    for (const d of erp.documents({ kind: "customer conversation" })) {
      try {
        const body = d.body ? (JSON.parse(d.body) as { channel?: string; claim_id?: string }) : null;
        if (body?.channel === "phone" || (body?.claim_id && removed.includes(body.claim_id))) {
          erp.db.delete(s.documents).where(eq(s.documents.docId, d.docId)).run();
        }
      } catch {
        /* ignore non-JSON bodies */
      }
    }
    if (removed.length) {
      erp.log("code", "dispute.phone_cleared", null, { detail: { removed } });
    }
  });
  return { removed };
}
