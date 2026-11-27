// HACCP Salus — abbonamenti con Stripe.
//
// Chi paga: ogni azienda cliente paga LabService direttamente dall'app.
// Prezzo e piano (mensile o annuale) li decide LabService per ogni azienda (aziende.prezzo_cent, aziende.piano).
// Primo abbonamento: 7 giorni di prova con la carta inserita subito, poi l'addebito parte da solo.
// Pagamento non riuscito: 3 giorni di tolleranza, poi l'app si blocca (regola in public.abbonamento_ok).
//
// Segreto richiesto: STRIPE_SECRET_KEY (Supabase → Edge Functions → Secrets). sk_test_/rk_test_ = prova, sk_live_/rk_live_ = reale.
// Prodotto, portale clienti e webhook su Stripe vengono creati da soli la prima volta (azione "setup").
//
// Azioni (POST JSON con { azione }):
//   utente dell'azienda:  stato, checkout, portale
//   solo LabService:      setup, stato (con azienda_id), applica_prezzo
//   Stripe (webhook):     il corpo è un evento; la funzione lo rilegge da Stripe con la chiave segreta,
//                         quindi un evento falso non può cambiare nulla (non serve il segreto del webhook).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const GIORNI_PROVA = 7;
const APP = "haccp-salus";
const WEBHOOK_URL = `${SB_URL}/functions/v1/pagamenti`;
const EVENTI = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// ---------- Stripe REST (form-encoded, oggetti annidati come a[b][c]) ----------
type P = Record<string, unknown>;
function form(o: P, pre = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    const key = pre ? `${pre}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? form(x as P, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)));
    else if (typeof v === "object") form(v as P, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}
class StripeErr extends Error {}
// deno-lint-ignore no-explicit-any
async function st(method: "GET" | "POST" | "DELETE", path: string, params: P = {}): Promise<any> {
  const q = form(params).join("&");
  const url = `https://api.stripe.com/v1/${path}${method === "GET" && q ? `?${q}` : ""}`;
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? q : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new StripeErr((j && j.error && j.error.message) || `Stripe: errore ${r.status}`);
  return j;
}
const modalita = () => (/_live_/.test(KEY) ? "live" : /_test_/.test(KEY) ? "test" : "sconosciuta");

// ---------- configurazione su Stripe (si crea da sola, in test e in live) ----------
let PRODOTTO = "";
async function prodotto(): Promise<string> {
  if (PRODOTTO) return PRODOTTO;
  let after: string | undefined;
  for (let i = 0; i < 10; i++) {
    const l = await st("GET", "products", { limit: 100, active: true, starting_after: after });
    const p = l.data.find((x: P & { metadata?: P }) => x.metadata && x.metadata.app === APP);
    if (p) return (PRODOTTO = p.id);
    if (!l.has_more) break;
    after = l.data[l.data.length - 1].id;
  }
  const p = await st("POST", "products", {
    name: "Abbonamento HACCP Salus",
    description: "Web-app per l'autocontrollo HACCP, la tracciabilità e la rintracciabilità.",
    metadata: { app: APP },
  });
  return (PRODOTTO = p.id);
}
let PORTALE = "";
async function portale(): Promise<string> {
  if (PORTALE) return PORTALE;
  const l = await st("GET", "billing_portal/configurations", { limit: 100, active: true });
  const c = l.data.find((x: P & { metadata?: P }) => x.metadata && x.metadata.app === APP);
  if (c) return (PORTALE = c.id);
  const n = await st("POST", "billing_portal/configurations", {
    business_profile: { headline: "LabService srls · abbonamento HACCP Salus" },
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id", "name"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
    },
    metadata: { app: APP },
  });
  return (PORTALE = n.id);
}
async function webhook(): Promise<string> {
  const l = await st("GET", "webhook_endpoints", { limit: 100 });
  const w = l.data.find((x: P) => x.url === WEBHOOK_URL);
  if (w) {
    const mancano = EVENTI.some((e) => !(w.enabled_events as string[]).includes(e) && !(w.enabled_events as string[]).includes("*"));
    if (mancano || w.status !== "enabled") await st("POST", `webhook_endpoints/${w.id}`, { enabled_events: EVENTI, disabled: false });
    return w.id as string;
  }
  const n = await st("POST", "webhook_endpoints", { url: WEBHOOK_URL, enabled_events: EVENTI, description: "HACCP Salus: stato degli abbonamenti" });
  return n.id;
}

// ---------- stato dell'abbonamento: da Stripe alla tabella aziende ----------
type Az = {
  id: string; nome: string; piva: string | null; pec: string | null; attivo: boolean; demo: boolean;
  pagamento: string; piano: string | null; prezzo_cent: number | null;
  stripe_customer: string | null; stripe_sub: string | null; sub_stato: string | null;
  sub_fine_periodo: string | null; prova_fine: string | null; prova_usata: boolean; insoluto_dal: string | null;
};
const iso = (t: unknown) => (typeof t === "number" && t > 0 ? new Date(t * 1000).toISOString() : null);
// deno-lint-ignore no-explicit-any
async function salvaSub(sb: SupabaseClient, az: Az, sub: any) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const fine = iso(sub.current_period_end ?? (item && item.current_period_end));
  const insolvente = ["past_due", "unpaid"].includes(sub.status);
  const upd = {
    stripe_sub: sub.id,
    stripe_customer: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? az.stripe_customer,
    sub_stato: sub.status,
    sub_fine_periodo: fine,
    prova_fine: iso(sub.trial_end),
    prova_usata: az.prova_usata || Boolean(sub.trial_end),
    insoluto_dal: insolvente ? az.insoluto_dal ?? new Date().toISOString() : null,
    sub_aggiornato: new Date().toISOString(),
  };
  const { data, error } = await sb.from("aziende").update(upd).eq("id", az.id).select().single();
  if (error) throw error;
  return data as Az;
}
// Rilegge da Stripe l'abbonamento più recente dell'azienda e aggiorna la tabella.
async function sincronizza(sb: SupabaseClient, az: Az): Promise<Az> {
  if (!KEY || az.pagamento !== "stripe") return az;
  let sub = null;
  if (az.stripe_sub) {
    try { sub = await st("GET", `subscriptions/${az.stripe_sub}`); } catch { sub = null; }
  }
  if (az.stripe_customer && (!sub || ["canceled", "incomplete_expired"].includes(sub.status))) {
    const l = await st("GET", "subscriptions", { customer: az.stripe_customer, status: "all", limit: 5 });
    const vivi = l.data.filter((s: P) => !["canceled", "incomplete_expired"].includes(String(s.status)));
    sub = vivi[0] || l.data[0] || sub;
  }
  return sub ? await salvaSub(sb, az, sub) : az;
}
const ok = (a: Az) =>
  a.attivo && (a.demo || a.pagamento === "esente" || ["trialing", "active"].includes(a.sub_stato || "") ||
    (["past_due", "unpaid"].includes(a.sub_stato || "") && !!a.insoluto_dal && Date.now() < Date.parse(a.insoluto_dal) + 3 * 864e5));
const vista = (a: Az) => ({
  pagamento: a.pagamento, piano: a.piano, prezzo_cent: a.prezzo_cent, sub_stato: a.sub_stato,
  sub_fine_periodo: a.sub_fine_periodo, prova_fine: a.prova_fine, prova_usata: a.prova_usata,
  insoluto_dal: a.insoluto_dal, cliente: Boolean(a.stripe_customer), ok: ok(a), modalita: KEY ? modalita() : null,
});
const prezzoStripe = (a: Az, prod: string) => ({
  currency: "eur",
  product: prod,
  unit_amount: a.prezzo_cent,
  recurring: { interval: a.piano === "annuale" ? "year" : "month" },
  tax_behavior: "inclusive", // l'importo deciso da LabService è il totale che il cliente paga
});
// L'indirizzo a cui Stripe rimanda dopo il pagamento: solo pagine web, senza parametri estranei.
function ritorno(v: unknown): string | null {
  try {
    const u = new URL(String(v || ""));
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);
  const sb = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

  // deno-lint-ignore no-explicit-any
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }

  // ---------- webhook di Stripe ----------
  if (b && b.object === "event" && typeof b.id === "string") {
    if (!KEY) return json({ ricevuto: true, ignorato: "chiave Stripe mancante" });
    let ev;
    try { ev = await st("GET", `events/${encodeURIComponent(b.id)}`); } catch { return json({ error: "Evento sconosciuto" }, 400); }
    const o = ev.data && ev.data.object;
    let subId: string | null = null, cust: string | null = null, azId: string | null = null;
    if (o.object === "subscription") { subId = o.id; cust = o.customer; azId = o.metadata && o.metadata.azienda_id; }
    else if (o.object === "checkout.session") { subId = o.subscription; cust = o.customer; azId = o.client_reference_id || (o.metadata && o.metadata.azienda_id); }
    else if (o.object === "invoice") {
      subId = o.subscription || (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || null;
      cust = o.customer;
    }
    let q = sb.from("aziende").select("*");
    if (azId) q = q.eq("id", azId);
    else if (subId) q = q.eq("stripe_sub", subId);
    else if (cust) q = q.eq("stripe_customer", cust);
    else return json({ ricevuto: true });
    let { data: az } = await q.maybeSingle();
    if (!az && cust) ({ data: az } = await sb.from("aziende").select("*").eq("stripe_customer", cust).maybeSingle());
    if (!az) return json({ ricevuto: true, ignorato: "azienda non trovata" });
    if (subId) {
      const sub = await st("GET", `subscriptions/${subId}`);
      await salvaSub(sb, az as Az, sub);
    } else await sincronizza(sb, az as Az);
    return json({ ricevuto: true });
  }

  // ---------- chiamate dall'app: serve un utente collegato ----------
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = token ? await sb.auth.getUser(token) : { data: null };
  if (!who?.user) return json({ error: "Sessione scaduta: rientra" }, 401);
  const { data: me } = await sb.from("profili").select("azienda_id, admin, attivo").eq("user_id", who.user.id).maybeSingle();
  if (!me?.attivo) return json({ error: "Account non attivo" }, 403);
  const admin = me.admin === true;

  try {
    switch (b.azione) {
      case "setup": {
        if (!admin) return json({ error: "Funzione riservata a LabService" }, 403);
        if (!KEY) return json({ configurato: false, messaggio: "Manca STRIPE_SECRET_KEY nei segreti delle Edge Functions di Supabase" });
        const [p, c, w] = await Promise.all([prodotto(), portale(), webhook()]);
        const acct = await st("GET", "account");
        return json({ configurato: true, modalita: modalita(), account: acct.settings?.dashboard?.display_name || acct.business_profile?.name || acct.id, prodotto: p, portale: c, webhook: w });
      }

      case "stato": {
        const id = admin && b.azienda_id ? String(b.azienda_id) : me.azienda_id;
        const { data: az } = await sb.from("aziende").select("*").eq("id", id).maybeSingle();
        if (!az) return json({ error: "Azienda non trovata" }, 404);
        const a = await sincronizza(sb, az as Az);
        return json({ abbonamento: vista(a) });
      }

      case "checkout": {
        if (!KEY) return json({ error: "I pagamenti non sono ancora attivi: contatta LabService" }, 503);
        const { data: az0 } = await sb.from("aziende").select("*").eq("id", me.azienda_id).single();
        let az = await sincronizza(sb, az0 as Az);
        if (az.pagamento !== "stripe") return json({ error: "Il pagamento di questa azienda è gestito da LabService" }, 400);
        if (!az.attivo) return json({ error: "Accesso sospeso: contatta LabService" }, 403);
        if (!az.prezzo_cent || !az.piano) return json({ error: "LabService non ha ancora impostato il tuo piano: contattali" }, 400);
        if (["trialing", "active", "past_due", "unpaid"].includes(az.sub_stato || "")) return json({ error: "L'abbonamento c'è già: usa \"Gestisci pagamento\" per aggiornare la carta" }, 409);
        const back = ritorno(b.ritorno);
        if (!back) return json({ error: "Indirizzo di ritorno non valido" }, 400);
        if (!az.stripe_customer) {
          const c = await st("POST", "customers", {
            name: az.nome, email: az.pec && /@/.test(az.pec) ? az.pec : undefined,
            metadata: { azienda_id: az.id, app: APP, piva: az.piva || undefined },
            preferred_locales: ["it"],
          });
          const { data } = await sb.from("aziende").update({ stripe_customer: c.id }).eq("id", az.id).select().single();
          az = data as Az;
        }
        const prova = !az.prova_usata;
        const s = await st("POST", "checkout/sessions", {
          mode: "subscription",
          customer: az.stripe_customer,
          client_reference_id: az.id,
          locale: "it",
          line_items: [{ price_data: prezzoStripe(az, await prodotto()), quantity: 1 }],
          payment_method_collection: "always",
          billing_address_collection: "required",
          tax_id_collection: { enabled: true },
          customer_update: { name: "auto", address: "auto" },
          subscription_data: { trial_period_days: prova ? GIORNI_PROVA : undefined, metadata: { azienda_id: az.id, app: APP } },
          metadata: { azienda_id: az.id, app: APP },
          success_url: `${back}?pagamento=ok`,
          cancel_url: `${back}?pagamento=annullato`,
        });
        return json({ url: s.url, prova });
      }

      case "portale": {
        if (!KEY) return json({ error: "I pagamenti non sono ancora attivi" }, 503);
        const { data: az } = await sb.from("aziende").select("*").eq("id", me.azienda_id).single();
        if (!az?.stripe_customer) return json({ error: "Non c'è ancora un abbonamento da gestire" }, 400);
        const back = ritorno(b.ritorno);
        if (!back) return json({ error: "Indirizzo di ritorno non valido" }, 400);
        const s = await st("POST", "billing_portal/sessions", { customer: az.stripe_customer, configuration: await portale(), return_url: back, locale: "it" });
        return json({ url: s.url });
      }

      case "applica_prezzo": {
        // LabService ha cambiato prezzo o piano. Stesso piano, prezzo diverso: vale dal prossimo rinnovo.
        // Da mensile ad annuale (o viceversa): Stripe fa partire subito il nuovo periodo e lo addebita.
        if (!admin) return json({ error: "Funzione riservata a LabService" }, 403);
        const { data: az } = await sb.from("aziende").select("*").eq("id", String(b.azienda_id || "")).maybeSingle();
        if (!az) return json({ error: "Azienda non trovata" }, 404);
        if (!KEY || !az.stripe_sub || !az.prezzo_cent || !az.piano) return json({ applicato: false });
        const sub = await st("GET", `subscriptions/${az.stripe_sub}`);
        if (["canceled", "incomplete_expired"].includes(sub.status)) return json({ applicato: false });
        const item = sub.items.data[0];
        const nuovo = await st("POST", `subscriptions/${sub.id}`, {
          items: [{ id: item.id, price_data: prezzoStripe(az as Az, await prodotto()) }],
          proration_behavior: "none",
        });
        await salvaSub(sb, az as Az, nuovo);
        return json({ applicato: true });
      }

      default:
        return json({ error: "Azione sconosciuta" }, 400);
    }
  } catch (e) {
    const m = e instanceof StripeErr ? e.message : (e as Error)?.message || "Errore";
    return json({ error: m }, e instanceof StripeErr ? 502 : 500);
  }
});
