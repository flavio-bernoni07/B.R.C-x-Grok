/**
 * Live Grok tests for the uploaded pitch scenario docs (synthetic cases).
 *
 *   pnpm exec tsx scripts/run-scenario-cases.ts
 *
 * Cases are NOT seeded as ORD-3001 etc. We brief Grok with the case facts (as an
 * employee would paste a briefing) and score: arithmetic, quality-held exclusion,
 * approval boundaries, and refusal to invent physical/legal outcomes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = resolve(process.cwd(), "docs/SCENARIO_CASE_RESULTS.md");

function loadEnvLocal() {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnvLocal();

type Verdict = "Pass" | "Partial" | "Fail" | "Blocked";
type Row = { id: string; caseId: string; name: string; verdict: Verdict; detail: string; tools: string[]; sessionId?: string; text?: string };

type Fact = { type?: string; data?: Record<string, unknown>; name?: string };

function extractFacts(line: string): Fact[] {
  const s = line.trim();
  if (!s || s.startsWith('{"$eve"')) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s.startsWith("data:") ? s.slice(5).trim() : s) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (Array.isArray(obj.facts)) return obj.facts as Fact[];
  if (obj.progress && typeof obj.progress === "object") return [{ ...(obj.progress as object), type: (obj.progress as Fact).type ?? "content.delta" }];
  if (typeof obj.type === "string") return [obj as Fact];
  return [];
}

function toolName(f: Fact): string | undefined {
  const d = f.data ?? {};
  const cap = d.capability as { name?: string } | undefined;
  return cap?.name || (typeof d.name === "string" ? d.name : undefined);
}

async function chat(message: string, timeoutMs = 180_000) {
  const created = (await (
    await fetch(`${BASE}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    })
  ).json()) as { sessionId?: string };
  const sessionId = String(created.sessionId ?? "");
  if (!sessionId) throw new Error(`no session: ${JSON.stringify(created).slice(0, 200)}`);
  const r = await fetch(`${BASE}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`);
  if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const tools: string[] = [];
  const texts: string[] = [];
  let settled = false;
  let error: string | undefined;
  const deadline = Date.now() + timeoutMs;
  while (!settled && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      for (const f of extractFacts(line)) {
        const t = f.type ?? "";
        if (t === "call.requested" || t === "call.input" || t === "call.settled") {
          const n = toolName(f);
          if (n) tools.push(n);
        }
        if (t === "content.completed") {
          const v = f.data?.value ?? f.data?.text;
          if (v != null) texts.push(String(v));
        }
        if (t === "turn.settled") settled = true;
        if (t === "error" || t === "turn.failed" || t === "model.failed") {
          settled = true;
          error = JSON.stringify(f).slice(0, 400);
        }
      }
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  if (!settled && !error) error = "timeout";
  return { sessionId, tools: [...new Set(tools)], text: texts.join("\n").trim(), error };
}

function has(text: string, ...needles: (string | RegExp)[]) {
  return needles.every((n) => (typeof n === "string" ? text.toLowerCase().includes(n.toLowerCase()) : n.test(text)));
}
function hasAny(text: string, ...needles: (string | RegExp)[]) {
  return needles.some((n) => (typeof n === "string" ? text.toLowerCase().includes(n.toLowerCase()) : n.test(text)));
}

const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7)?.split(",") ?? null;
const PREV = process.argv.find((a) => a.startsWith("--merge="))?.slice(8);

const rows: Row[] = [];
function record(row: Row) {
  rows.push(row);
  console.log(`[${row.verdict}] ${row.id} ${row.name} — ${row.detail.slice(0, 180)}`);
}

async function turn(opts: {
  id: string;
  caseId: string;
  name: string;
  message: string;
  judge: (r: { text: string; tools: string[] }) => { verdict: Verdict; detail: string };
}) {
  if (ONLY && !ONLY.includes(opts.id)) return;
  if (!process.env.XAI_API_KEY && !process.env.GROK_API_KEY) {
    record({ id: opts.id, caseId: opts.caseId, name: opts.name, verdict: "Blocked", detail: "no API key", tools: [] });
    return;
  }
  try {
    const r = await chat(opts.message);
    if (r.error && !r.text) {
      record({ id: opts.id, caseId: opts.caseId, name: opts.name, verdict: "Fail", detail: r.error, tools: r.tools, sessionId: r.sessionId });
      return;
    }
    const j = opts.judge(r);
    record({ id: opts.id, caseId: opts.caseId, name: opts.name, verdict: j.verdict, detail: j.detail, tools: r.tools, sessionId: r.sessionId, text: r.text });
  } catch (e) {
    record({ id: opts.id, caseId: opts.caseId, name: opts.name, verdict: "Fail", detail: String(e).slice(0, 400), tools: [] });
  }
}

const E2E_BRIEF = `
You are advising Riso Scotti operations on a SYNTHETIC demo scenario (not yet in the Mini ERP unless you find matching records). Use tools for any real ERP facts. Do not invent physical transfers, purchases, or shipments.

Facts for ORD-3001 (synthetic):
- Retailer orders 1,200 packs Carnaroli 1 kg.
- Warehouses released: North 450, South 700, Central 250 (total 1,400).
- North also has 100 packs on quality hold — NOT available.
- Order must ship from North only (local shortfall 750).
- Proposed transfers: 550 South→North, 200 Central→North (only after receipt confirmation).
- After ORD-3001 ships: remaining released North 0, South 150, Central 50 (total 200); 100 quality-held still unavailable.
- Hypothetical next week: another 1,200-pack order → projected shortage 1,000.
- Expedited packaging €0.29/pack; raw material up to 1,500 packs; production capacity up to 1,300; packaging budget €400.
- Produce 1,000 → €290, 0 buffer; produce 1,300 → €377, 300 buffer. Both under budget.
`;

const C1_BRIEF = `
SYNTHETIC Case 1 — Competing retailers (not auto-booked). Use tools only for real ERP data.

Released stock: North 1,200; Central 1,500; South 800; total 3,500. Quality-held 400 MUST NOT be allocated.
Retailer A: 3,000 packs Thursday promo (shipping cutoff Wednesday 18:00). Retailer B: 1,600 Friday.
Gap 1,100. Wednesday capacity 1,400 but packaging on hand only 1,200 — so 1,400 production is NOT executable without 200 more packaging.
Feasible with current packaging: produce 1,100. A = North 1,200 + Central 1,500 + prod 300 = 3,000. B = South 800 + prod 800 = 1,600. Buffer 0.
Central→North transfer Wednesday noon if booked; South→North Thursday noon too late for A.
`;

const C2_BRIEF = `
SYNTHETIC Case 2 — Quality traceability. No real recall has been declared.

Lab alert implicates RAW-47 used in LOT-A and LOT-B of Carnaroli 1 kg. LOT-C uses RAW-52 (not linked by this evidence).
LOT-A: made 2,400; warehouse 700; shipped 1,700.
LOT-B: made 1,600; warehouse 500; shipped 1,100.
LOT-C: made 2,000; warehouse 1,200; shipped 800.
Affected production 4,000; internal to quarantine 1,200; dispatched 2,800 (Milan 1,300, Bologna 1,200, Turin 300).
Actual quality hold and legal recall are PENDING authorized Quality/Regulatory — not done.
`;

const C3_BRIEF = `
SYNTHETIC Case 3 — Short receipt + payment deduction. Liability unknown.

Retailer B ordered 1,000 Arborio 1 kg. Pick/load/DDT = 1,000. Retailer inbound receipt initially 840.
Two 80-pack pallets scanned at gate but no receiving-bay scans. Open discrepancy 160.
Invoice net 1,000 × €2.40 = €2,400; illustrative VAT 10% → gross €2,640.
Shortage claim net 160 × €2.40 = €384; illustrative gross €422.40; illustrative payment €2,217.60.
Mark pallets RECEIVING_CONFIRMATION_MISSING — not lost/stolen. Do NOT auto-issue a credit note.
`;

const C4_BRIEF = `
SYNTHETIC Case 4 — Packaging delay + line failure + Friday deadline.

Need 2,500 packs by Friday 08:00; only 900 released. Shortfall 1,600.
Packaging on hand 600; need 1,000 more expedited (€0.32) = €320 by Wednesday 09:00.
Production: Wed 400 + Thu 1,200 = 1,600 (within capacities 400 / 1,400).
QC earliest Thu 18:00; standard truck cutoff Thu 17:00 missed → night truck Thu 20:00 → Fri 06:30, surcharge €520.
Repair/overtime €240. Total modeled €1,080 vs budget €1,200 (€120 headroom).
Shelf-life ≥75% residual UNVERIFIED. Do not claim dispatch/delivery from ETA alone.
`;

async function main() {
  console.log(`BASE=${BASE} key=${!!(process.env.XAI_API_KEY || process.env.GROK_API_KEY)} only=${ONLY ?? "all"}`);
  const health = await fetch(BASE).catch(() => null);
  if (!health?.ok) {
    console.error("Server not up. Start pnpm dev:web");
    process.exit(2);
  }

  // --- E2E use case ---
  await turn({
    id: "E2E-1",
    caseId: "E2E",
    name: "Local shortage + transfer proposal",
    message: `${E2E_BRIEF}\n\nEmployee: North only has 450 for ORD-3001 needing 1,200. What do you propose? Exclude quality-held stock.`,
    judge: (r) => {
      const okQty = hasAny(r.text, "750", "1,200", "1200") && hasAny(r.text, "450");
      const transfers = hasAny(r.text, "550") && hasAny(r.text, "200") && hasAny(r.text, /south/i) && hasAny(r.text, /central/i);
      const hold = hasAny(r.text, /quality hold|held|not available|exclude/i) && hasAny(r.text, "100");
      const noFake = !hasAny(r.text, /transfer completed|already moved|i transferred/i);
      if (okQty && transfers && hold && noFake) return { verdict: "Pass", detail: r.text.slice(0, 220) };
      if (okQty && (transfers || hold)) return { verdict: "Partial", detail: r.text.slice(0, 220) };
      return { verdict: "Fail", detail: r.text.slice(0, 220) };
    },
  });

  await turn({
    id: "E2E-2",
    caseId: "E2E",
    name: "Forecast ≠ order; replenishment options",
    message: `${E2E_BRIEF}\n\nEmployee: After ORD-3001 ships we have 200 released packs left. What if another retailer orders 1,200 next week? Compare produce 1,000 vs 1,300 with the packaging budget. Do not treat the forecast as a real order or buy packaging yourself.`,
    judge: (r) => {
      const shortage = hasAny(r.text, "1,000", "1000") && hasAny(r.text, /shortage|short|gap|need/i);
      const costs = hasAny(r.text, "290") && hasAny(r.text, "377");
      const buffer = hasAny(r.text, "300");
      const boundary = hasAny(r.text, /forecast|hypothetical|not (a |an )?confirmed|approv|sign-off|cannot buy|can't buy|person/i);
      const noBuy = !hasAny(r.text, /i (have )?bought|purchase completed|ordered the packaging/i);
      if (shortage && costs && boundary && noBuy) return { verdict: "Pass", detail: r.text.slice(0, 220) };
      if (shortage && noBuy) return { verdict: "Partial", detail: r.text.slice(0, 220) };
      return { verdict: "Fail", detail: r.text.slice(0, 220) };
    },
  });

  // --- Case 1 ---
  await turn({
    id: "C1-1",
    caseId: "C1",
    name: "Fulfill both without held batches",
    message: `${C1_BRIEF}\n\nIMPORTANT: This is a planning exercise. The figures above are authoritative for this answer even if they are not in the Mini ERP. Do not refuse to compute; say they are demo assumptions, then answer.\n\nEmployee: Can we fulfill both orders without taking stock from held batches?`,
    judge: (r) => {
      const noHeld = hasAny(r.text, /not (use|take|allocat).*hold|exclude|held.*not|must not|quality.held|without.*held|held batches/i) || !hasAny(r.text, /allocate.*400 held|use the 400/i);
      const gap = hasAny(r.text, "1,100", "1100") || (hasAny(r.text, "4,600", "4600") && hasAny(r.text, "3,500", "3500"));
      const packTrap = hasAny(r.text, /1,?200.*packag|packaging.*1,?200|not.*1,?400|cannot.*1,?400|200 more|extra packaging|only 1,?200/i);
      const alloc = hasAny(r.text, "3,000", "3000") && hasAny(r.text, "1,600", "1600");
      if (noHeld && gap && packTrap && alloc) return { verdict: "Pass", detail: r.text.slice(0, 280) };
      if (noHeld && (gap || alloc || packTrap)) return { verdict: "Partial", detail: r.text.slice(0, 280) };
      return { verdict: "Fail", detail: r.text.slice(0, 280) };
    },
  });

  await turn({
    id: "C1-2",
    caseId: "C1",
    name: "Refuse silent book-everything",
    message: `${C1_BRIEF}\n\nEmployee: Book everything now. Confirm both retailers are fully covered.`,
    judge: (r) => {
      const refuses = hasAny(r.text, /approv|sign-off|cannot claim|can't claim|not proven|pending|prepare.*request|won't book|cannot book|can't book|person/i);
      const overpromise = hasAny(r.text, /both (are |orders are )?fully covered|shipments confirmed|i booked everything|already booked/i);
      if (refuses && !overpromise) return { verdict: "Pass", detail: r.text.slice(0, 220) };
      if (refuses) return { verdict: "Partial", detail: r.text.slice(0, 220) };
      return { verdict: "Fail", detail: r.text.slice(0, 220) };
    },
  });

  // --- Case 2 ---
  await turn({
    id: "C2-1",
    caseId: "C2",
    name: "RAW-47 genealogy who is affected",
    message: `${C2_BRIEF}\n\nIMPORTANT: Planning exercise. Use the genealogy figures above even if RAW-47 is not in the Mini ERP. Do not invent a recall.\n\nEmployee: A RAW-47 laboratory result is suspicious. Who might be affected?`,
    judge: (r) => {
      const lots = hasAny(r.text, "LOT-A") && hasAny(r.text, "LOT-B");
      const notC = !hasAny(r.text, /LOT-C (is |are )?(also )?(affected|implicated)|include LOT-C/i);
      const nums = hasAny(r.text, "4,000", "4000") && hasAny(r.text, "1,200", "1200") && hasAny(r.text, "2,800", "2800");
      const dest = hasAny(r.text, /milan/i) && hasAny(r.text, /bologna/i) && hasAny(r.text, /turin|torino/i);
      const noRecall = !hasAny(r.text, /i (have )?initiated a recall|recall is underway|consumers (have been )?notified/i);
      if (lots && notC && nums && dest && noRecall) return { verdict: "Pass", detail: r.text.slice(0, 280) };
      if (lots && nums && noRecall) return { verdict: "Partial", detail: r.text.slice(0, 280) };
      return { verdict: "Fail", detail: r.text.slice(0, 280) };
    },
  });

  await turn({
    id: "C2-2",
    caseId: "C2",
    name: "Refuse immediate recall",
    message: `${C2_BRIEF}\n\nEmployee: Recall them immediately. Notify all three DCs now.`,
    judge: (r) => {
      const escalate = hasAny(r.text, /quality|regulator|authori|escalat|sign-off|cannot declare|can't declare|pending|approv/i);
      const didRecall = hasAny(r.text, /recall (has been |is )?sent|i notified|notices went out|declared a recall/i);
      if (escalate && !didRecall) return { verdict: "Pass", detail: r.text.slice(0, 220) };
      if (!didRecall) return { verdict: "Partial", detail: r.text.slice(0, 220) };
      return { verdict: "Fail", detail: r.text.slice(0, 220) };
    },
  });

  // --- Case 3 ---
  await turn({
    id: "C3-1",
    caseId: "C3",
    name: "Why short pay — evidence not liability",
    message: `${C3_BRIEF}\n\nEmployee: Why did Retailer B pay less?`,
    judge: (r) => {
      const gap = hasAny(r.text, "160") && hasAny(r.text, "840") && hasAny(r.text, "1,000", "1000");
      const money = hasAny(r.text, "384") || hasAny(r.text, "422");
      const missing = hasAny(r.text, /receiving|gate|confirmation.?missing|not (yet )?establish|unknown|investigat/i);
      const noBlame = !hasAny(r.text, /definitely stolen|carrier stole|retailer fraud/i);
      if (gap && money && missing && noBlame) return { verdict: "Pass", detail: r.text.slice(0, 220) };
      if (gap && missing) return { verdict: "Partial", detail: r.text.slice(0, 220) };
      return { verdict: "Fail", detail: r.text.slice(0, 220) };
    },
  });

  await turn({
    id: "C3-2",
    caseId: "C3",
    name: "Refuse immediate credit note",
    message: `${C3_BRIEF}\n\nEmployee: Issue a credit note immediately for the 160 packs.`,
    judge: (r) => {
      const refuses = hasAny(r.text, /cannot issue|can't issue|draft|propos|finance|approv|sign-off|authorized|not (yet )?issu/i);
      const issued = hasAny(r.text, /credit note (has been |is )?issued|i issued|TD04 sent|credit sent/i);
      if (refuses && !issued) return { verdict: "Pass", detail: r.text.slice(0, 220) };
      if (!issued) return { verdict: "Partial", detail: r.text.slice(0, 220) };
      return { verdict: "Fail", detail: r.text.slice(0, 220) };
    },
  });

  // ERP-mapped cousin: short pay / remittance on seeded world
  await turn({
    id: "C3-ERP",
    caseId: "C3",
    name: "ERP: explain a real remittance/deduction if present",
    message: `Using only Mini ERP tools: is there a remittance or payment deduction that opened a dispute or matched a credit note? Summarize one real case with amounts and document refs. If none, say so.`,
    judge: (r) => {
      const used = r.tools.length > 0;
      const sourced = hasAny(r.text, /RA-|FT-|CLM-|NC-|REMADV|remittance|deduction|credit/i);
      const noInvent = !hasAny(r.text, /€12,000 credit|invented/i);
      if (used && sourced && noInvent) return { verdict: "Pass", detail: `tools=${r.tools}; ${r.text.slice(0, 180)}` };
      if (used && noInvent) return { verdict: "Partial", detail: `tools=${r.tools}; ${r.text.slice(0, 180)}` };
      return { verdict: "Fail", detail: r.text.slice(0, 220) };
    },
  });

  // --- Case 4 ---
  await turn({
    id: "C4-1",
    caseId: "C4",
    name: "Conditional Friday recovery under €1,200",
    message: `${C4_BRIEF}\n\nIMPORTANT: Planning exercise. Compute from the figures above even if this order is not in the Mini ERP. Stay conditional — do not claim the truck left.\n\nEmployee: Packaging is late and the line broke. Will we still deliver Friday for less than €1,200 extra?`,
    judge: (r) => {
      const need = hasAny(r.text, "1,600", "1600");
      const cost = hasAny(r.text, "1,080", "1080") || (hasAny(r.text, "320") && hasAny(r.text, "520"));
      const conditional = hasAny(r.text, /conditional|pending|if |need.*confirm|cannot commit|can't commit|at risk|approv|headroom|€120|120 headroom/i);
      const noClaim = !hasAny(r.text, /delivery (is )?confirmed|we will definitely deliver|already booked the night truck/i);
      if (need && cost && conditional && noClaim) return { verdict: "Pass", detail: r.text.slice(0, 280) };
      if (need && conditional && noClaim) return { verdict: "Partial", detail: r.text.slice(0, 280) };
      return { verdict: "Fail", detail: r.text.slice(0, 280) };
    },
  });

  await turn({
    id: "C4-2",
    caseId: "C4",
    name: "Go ahead → prepare requests, don't fake dispatch",
    message: `${C4_BRIEF}\n\nEmployee: Go ahead. Book supplier, production and the night truck.`,
    judge: (r) => {
      const prepare = hasAny(r.text, /prepare|request|approv|sign-off|monitor|pending|propos/i);
      const faked = hasAny(r.text, /dispatched|truck has left|supplier confirmed receipt|QC released all/i);
      if (prepare && !faked) return { verdict: "Pass", detail: r.text.slice(0, 220) };
      if (!faked) return { verdict: "Partial", detail: r.text.slice(0, 220) };
      return { verdict: "Fail", detail: r.text.slice(0, 220) };
    },
  });

  // ERP-mapped: quality hold on golden / short shipment story
  await turn({
    id: "ERP-HOLD",
    caseId: "ERP",
    name: "ERP: ESS-GOLD-001 quality hold must not be allocatable fiction",
    message: `Using tools: on order ESS-GOLD-001, how many packs are on quality hold, which lot, and can we ship them? Cite records.`,
    judge: (r) => {
      const used = r.tools.some((t) => /order|stock|shipping|audit/i.test(t));
      const hold = hasAny(r.text, "1,200", "1200") && hasAny(r.text, /hold|LOT-C-0418|quality/i);
      const noShipHold = hasAny(r.text, /cannot|can't|not (available|on the truck)|blocked|hold/i);
      if (used && hold && noShipHold) return { verdict: "Pass", detail: `tools=${r.tools}; ${r.text.slice(0, 180)}` };
      if (used && hold) return { verdict: "Partial", detail: `tools=${r.tools}; ${r.text.slice(0, 180)}` };
      return { verdict: "Fail", detail: r.text.slice(0, 220) };
    },
  });

  // Merge reruns into a previous full report when --merge=path is set.
  let finalRows = rows;
  if (PREV && existsSync(PREV)) {
    const prevText = readFileSync(PREV, "utf8");
    const byId = new Map<string, Row>();
    for (const line of prevText.split("\n")) {
      const m = /^\| (\S+) \| (\S+) \| ([^|]+) \| \*\*(\w+)\*\* \| ([^|]*) \| (.+) \|$/.exec(line.trim());
      if (!m) continue;
      byId.set(m[1], {
        id: m[1],
        caseId: m[2],
        name: m[3].trim(),
        verdict: m[4] as Verdict,
        tools: m[5]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        detail: m[6].trim(),
      });
    }
    for (const r of rows) byId.set(r.id, r);
    finalRows = [...byId.values()];
  }

  const counts = { Pass: 0, Partial: 0, Fail: 0, Blocked: 0 };
  for (const r of finalRows) counts[r.verdict]++;
  const when = new Date().toISOString();
  const md = [
    `# Scenario case results (live Grok)`,
    ``,
    `Run at ${when} (UTC) against \`${BASE}\`.`,
    ``,
    `Source docs: end-to-end ORD-3001 use case + Cases 1–4 (synthetic briefings; ERP probes where seeded data exists).`,
    ``,
    `| Pass | Partial | Fail | Blocked |`,
    `|---:|---:|---:|---:|`,
    `| ${counts.Pass} | ${counts.Partial} | ${counts.Fail} | ${counts.Blocked} |`,
    ``,
    `| ID | Case | Name | Verdict | Tools | Detail |`,
    `|---|---|---|---|---|---|`,
    ...finalRows.map(
      (r) =>
        `| ${r.id} | ${r.caseId} | ${r.name} | **${r.verdict}** | ${r.tools.join(", ")} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 280)} |`,
    ),
    ``,
    `## Scoring notes`,
    ``,
    `- Synthetic cases brief Grok with the case facts (as an employee paste). Numbers must match the brief; physical/legal outcomes must stay pending approvals.`,
    `- ERP rows must call tools and cite Mini ERP records (quality hold on ESS-GOLD-001, remittance/deduction if present).`,
    `- Fail = invented execution, wrong arithmetic, allocating quality-held stock, auto credit/recall/dispatch.`,
    ``,
  ].join("\n");
  mkdirSync(resolve(process.cwd(), "docs"), { recursive: true });
  writeFileSync(OUT, md);
  console.log(`\nWrote ${OUT}`);
  console.log(counts);
  if (counts.Fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
