// HACCP Salus — Area LabService: aziende e utenti.
// Solo un utente con profili.admin = true può chiamarla.
// La chiave service role resta sul server (variabile di sistema di Supabase).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DOMINIO = "utenti.haccp-salus.app"; // indirizzo interno: gli utenti entrano con il nome utente

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8" } });

const txt = (v: unknown, n = 200) => {
  const s = String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
  return s || null;
};
const toEmail = (u: string) => (u.includes("@") ? u : `${u}@${DOMINIO}`);
const USER_RE = /^[a-z0-9._-]{3,60}$/;

function genPassword() {
  const set = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint32Array(8));
  const p = Array.from(r, (x) => set[x % set.length]).join("");
  return `Salus-${p.slice(0, 4)}-${p.slice(4)}`;
}

const AZ_FIELDS = ["nome", "piva", "indirizzo", "referente", "settore", "telefono", "pec", "note"] as const;
function aziendaDa(b: Record<string, unknown>) {
  const o: Record<string, string | null> = {};
  for (const k of AZ_FIELDS) if (k in b) o[k] = txt(b[k], k === "note" ? 1000 : 200);
  return o;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);

  const sb = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Accesso richiesto" }, 401);
  const { data: who, error: whoErr } = await sb.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "Sessione scaduta: rientra" }, 401);
  const { data: me } = await sb.from("profili").select("admin, attivo").eq("user_id", who.user.id).maybeSingle();
  if (!me?.admin || !me.attivo) return json({ error: "Funzione riservata a LabService" }, 403);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "Richiesta non valida" }, 400);
  }

  try {
    switch (b.azione) {
      case "elenco": {
        const [{ data: aziende, error: e1 }, { data: profili, error: e2 }] = await Promise.all([
          sb.from("aziende").select("*").order("nome"),
          sb.from("profili").select("user_id, azienda_id, username, nome, descrizione, admin, must_change_pw, attivo, created_at").order("nome"),
        ]);
        if (e1 || e2) throw e1 || e2;
        const last: Record<string, string | null> = {};
        for (let page = 1; page <= 20; page++) {
          const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
          if (error) break;
          for (const u of data.users) last[u.id] = u.last_sign_in_at ?? null;
          if (data.users.length < 1000) break;
        }
        return json({
          aziende,
          utenti: (profili || []).map(({ user_id, ...p }) => ({ ...p, ultimo_accesso: last[user_id] ?? null })),
        });
      }

      case "crea_azienda": {
        const a = aziendaDa(b);
        if (!a.nome) return json({ error: "Manca la ragione sociale" }, 400);
        const { data, error } = await sb.from("aziende").insert(a).select().single();
        if (error) throw error;
        return json({ azienda: data });
      }

      case "modifica_azienda": {
        const id = txt(b.id, 40);
        if (!id) return json({ error: "Azienda mancante" }, 400);
        const a: Record<string, unknown> = aziendaDa(b);
        if (typeof b.attivo === "boolean") a.attivo = b.attivo;
        if ("nome" in a && !a.nome) return json({ error: "La ragione sociale non può essere vuota" }, 400);
        const { data, error } = await sb.from("aziende").update(a).eq("id", id).select().single();
        if (error) throw error;
        return json({ azienda: data });
      }

      case "crea_utente": {
        const username = String(b.username ?? "").trim().toLowerCase();
        const nome = txt(b.nome, 120);
        const azienda_id = txt(b.azienda_id, 40);
        if (!USER_RE.test(username)) return json({ error: "Nome utente: da 3 a 60 caratteri, solo lettere minuscole, numeri, punto, trattino" }, 400);
        if (!nome) return json({ error: "Manca nome e cognome" }, 400);
        if (!azienda_id) return json({ error: "Scegli l'azienda" }, 400);
        const { data: az } = await sb.from("aziende").select("id").eq("id", azienda_id).maybeSingle();
        if (!az) return json({ error: "Azienda non trovata" }, 400);
        const { data: dup } = await sb.from("profili").select("username").eq("username", username).maybeSingle();
        if (dup) return json({ error: "Questo nome utente esiste già" }, 409);
        const password = genPassword();
        const { data: cu, error: ce } = await sb.auth.admin.createUser({
          email: toEmail(username), password, email_confirm: true, user_metadata: { username, nome },
        });
        if (ce || !cu?.user) return json({ error: ce?.message || "Creazione non riuscita" }, 400);
        const { error: pe } = await sb.from("profili").insert({
          user_id: cu.user.id, azienda_id, username, nome, descrizione: txt(b.descrizione, 120), admin: b.admin === true,
        });
        if (pe) {
          await sb.auth.admin.deleteUser(cu.user.id);
          throw pe;
        }
        return json({ username, password });
      }

      case "reset_password": {
        const username = String(b.username ?? "").trim().toLowerCase();
        const { data: p } = await sb.from("profili").select("user_id").eq("username", username).maybeSingle();
        if (!p) return json({ error: "Utente non trovato" }, 404);
        const password = genPassword();
        const { error } = await sb.auth.admin.updateUserById(p.user_id, { password });
        if (error) throw error;
        await sb.from("profili").update({ must_change_pw: true }).eq("user_id", p.user_id);
        return json({ username, password });
      }

      case "attiva_utente": {
        const username = String(b.username ?? "").trim().toLowerCase();
        const attivo = b.attivo === true;
        const { data: p } = await sb.from("profili").select("user_id").eq("username", username).maybeSingle();
        if (!p) return json({ error: "Utente non trovato" }, 404);
        if (p.user_id === who.user.id && !attivo) return json({ error: "Non puoi disattivare il tuo account" }, 400);
        const { error } = await sb.auth.admin.updateUserById(p.user_id, { ban_duration: attivo ? "none" : "876000h" });
        if (error) throw error;
        await sb.from("profili").update({ attivo }).eq("user_id", p.user_id);
        return json({ ok: true });
      }

      case "modifica_utente": {
        const username = String(b.username ?? "").trim().toLowerCase();
        const upd: Record<string, unknown> = {};
        if ("nome" in b) { const n = txt(b.nome, 120); if (!n) return json({ error: "Manca nome e cognome" }, 400); upd.nome = n; }
        if ("descrizione" in b) upd.descrizione = txt(b.descrizione, 120);
        const { error } = await sb.from("profili").update(upd).eq("username", username);
        if (error) throw error;
        return json({ ok: true });
      }

      default:
        return json({ error: "Azione sconosciuta" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: "Operazione non riuscita: " + ((e as { message?: string })?.message || "errore") }, 500);
  }
});
