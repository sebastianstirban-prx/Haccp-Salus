// HACCP Salus — lettura con l'IA di Anthropic della foto di una fattura o (tipo "etichetta") di un'etichetta.
// La chiave resta sul server: segreto ANTHROPIC_API_KEY delle Edge Functions di Supabase.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-5-5";
const MAX_B64 = 7_000_000; // circa 5 MB di immagine
const TYPES = ["image/jpeg", "image/png", "image/webp"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, n);

function buildPrompt(azienda: { nome?: string; piva?: string }, fornitori: { nome?: string; piva?: string }[]) {
  const elenco = fornitori
    .map((f) => clip(f.nome, 80) + (f.piva ? ` (P.IVA ${clip(f.piva, 16)})` : ""))
    .join("; ");
  return `Leggi la foto di una fattura (o documento di trasporto) di un fornitore alimentare italiano, per il registro HACCP.
Rispondi SOLO con un oggetto JSON con questa forma, senza altro testo:
{"fornitore":{"nome":"...","piva":"..."},"numero":"...","data":"AAAA-MM-GG","righe":[{"prodotto":"...","lotto":"...","confezioni":6,"peso_kg":1,"scadenza":"AAAA-MM-GG"}]}
Regole:
- Il fornitore è chi emette il documento. Il destinatario è ${clip(azienda.nome, 80)} (P.IVA ${clip(azienda.piva, 16)}): non usarlo come fornitore.
- Una riga per ogni prodotto alimentare. Ignora trasporto, spese, sconti, imponibile, IVA e totali.
- "prodotto" è la descrizione senza codice articolo e senza peso.
- "confezioni" è il numero della colonna quantità (Q.tà, Quantità, Colli, Pezzi, N.), copiato così com'è.
- "peso_kg" è il peso scritto sulla riga (nella descrizione o nella colonna del peso), copiato così com'è e solo convertito in kg (500 g = 0.5). NON fare calcoli: non dividere il peso per la quantità e non moltiplicarlo. Esempio: "Farina 00 | Q.tà 4 | 100 kg" → confezioni 4, peso_kg 100 (cioè 4 confezioni da 100 kg).
- Se la quantità è espressa direttamente in kg (unità di misura KG) e non c'è un numero di confezioni, usa confezioni 1 e peso_kg uguale a quella quantità.
- Lotto e scadenza possono stare in colonne dedicate o sotto la descrizione.
- Se un dato non è leggibile o non c'è, usa null. Non inventare lotti, scadenze o numeri.
Fornitori già registrati, se uno corrisponde usa lo stesso nome: ${elenco || "nessuno"}.`;
}

const ALLERGENI = "Glutine, Crostacei, Uova, Pesce, Arachidi, Soia, Lattosio, Frutta a guscio, Sedano, Senape, Sesamo, Solfiti, Lupini, Molluschi";
function labelPrompt() {
  return `Leggi la foto dell'etichetta (o della confezione) di un prodotto alimentare, per il magazzino HACCP.
Rispondi SOLO con un oggetto JSON con questa forma, senza altro testo:
{"prodotto":"...","marca":"...","lotto":"...","scadenza":"AAAA-MM-GG","peso_kg":1,"allergeni":["..."],"ean":"..."}
Regole:
- "prodotto" è la denominazione di vendita breve (es. "Farina tipo 00", "Panna fresca 35%"), senza marca e senza peso.
- "lotto" è il codice dopo "Lotto", "Lot", "L." o "L": scrivi solo il codice.
- "scadenza" è la data dopo "Da consumarsi entro", "Da consumarsi preferibilmente entro", "TMC" o "Scad.". Se ci sono solo mese e anno, usa l'ultimo giorno del mese.
- "peso_kg" è il peso netto di una confezione in kg (500 g = 0.5).
- "allergeni": solo voci di questo elenco presenti negli ingredienti o nelle avvertenze, comprese le tracce ("può contenere"): ${ALLERGENI}. Latte e derivati = Lattosio; frutta a guscio comprende mandorle, nocciole, noci, pistacchi.
- "ean" sono le cifre stampate sotto il codice a barre, se leggibili (8 o 13 cifre).
- Se un dato non è leggibile o non c'è, usa null. Non inventare lotti, scadenze o codici.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);

  const sb = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = token ? await sb.auth.getUser(token) : { data: null };
  if (!who?.user) return json({ error: "Accesso richiesto" }, 401);
  const { data: p } = await sb.from("profili").select("attivo, aziende(attivo)").eq("user_id", who.user.id).maybeSingle();
  // deno-lint-ignore no-explicit-any
  if (!p?.attivo || !(p as any).aziende?.attivo) return json({ error: "Account o abbonamento non attivo" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Richiesta non valida" }, 400);
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (body.ping) return json({ ok: true, configured: Boolean(key), model: MODEL });
  if (!key) return json({ error: "Manca la chiave ANTHROPIC_API_KEY sul server" }, 500);

  const image = String(body.image || "");
  if (!image || image.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200)))
    return json({ error: "Immagine mancante o troppo grande" }, 413);
  const type = TYPES.includes(String(body.type)) ? String(body.type) : "image/jpeg";
  const azienda = body.azienda && typeof body.azienda === "object" ? (body.azienda as { nome?: string; piva?: string }) : {};
  const fornitori = Array.isArray(body.fornitori) ? (body.fornitori as { nome?: string; piva?: string }[]).slice(0, 200) : [];

  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: type, data: image } },
            { type: "text", text: body.tipo === "etichetta" ? labelPrompt() : buildPrompt(azienda, fornitori) },
          ],
        }],
      }),
    });
  } catch {
    return json({ error: "Servizio IA non raggiungibile" }, 502);
  }

  const j = await r.json().catch(() => null);
  if (!r.ok) return json({ error: (j && j.error && j.error.message) || `Errore ${r.status}` }, 502);
  const text = ((j && j.content) || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) return json({ error: "Risposta non leggibile" }, 502);
  try {
    return json({ data: JSON.parse(text.slice(a, b + 1)) });
  } catch {
    return json({ error: "Risposta non leggibile" }, 502);
  }
});
