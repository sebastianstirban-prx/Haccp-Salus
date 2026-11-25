# HACCP Salus — LabService srls

Web-app HACCP (un solo file `web/index.html`) con dati online su Supabase.

## Come è fatta

| Pezzo | Dove | Cosa fa |
|---|---|---|
| `web/index.html` | Netlify (si carica trascinando il file) | L'app. Fuori dall'anteprima lavora online. Con `?demo` in fondo all'indirizzo torna la demo locale, senza server. |
| Database | Supabase, progetto `haccp-salus` (Francoforte) | `aziende`, `profili` (utenti), `app_state` (tutti i dati dell'app, uno per azienda), `app_state_storico` (ultime 30 versioni per azienda). |
| Deposito file | Supabase Storage, bucket privato `foto` | Foto e documenti, in una cartella per azienda (`<id azienda>/img/…`, `<id azienda>/doc/…`). |
| `supabase/functions/admin-utenti` | Edge Function | Area LabService: crea aziende e utenti, genera password, sospende, riattiva. Solo per utenti con `admin = true`. |
| `supabase/functions/leggi-fattura` | Edge Function | Legge con Claude la foto di una fattura o, con `tipo: "etichetta"`, di un'etichetta (segreto `ANTHROPIC_API_KEY`). |
| `supabase/migrations` | | Lo schema del database, da rieseguire così com'è in un altro progetto. |

## Foto e codici a barre

- Fattura: l'IA legge fornitore, P.IVA, numero, data e righe (prodotto, lotto, confezioni, peso, scadenza). Senza chiave, lettore di testo sul telefono.
- Etichetta (Magazzino e Crea lotto): l'IA legge nome, marca, lotto, scadenza, peso e allergeni.
- Codice a barre: decodificato sul telefono (BarcodeDetector dove c'è, altrimenti ZXing). EAN: riconosce il prodotto già in magazzino, altrimenti cerca nome, marca e allergeni su Open Food Facts. GS1-128 dei cartoni: legge anche lotto e scadenza. L'EAN non contiene il lotto: per quello serve la foto dell'etichetta.

## Sicurezza

- Ogni utente vede e modifica solo i dati della propria azienda (regole RLS di Postgres e regole del deposito file). Verificato con un utente di prova di un'altra azienda: zero righe, zero file, nessuna modifica possibile.
- Gli utenti non possono scrivere direttamente nelle tabelle: si passa da funzioni che controllano azienda, abbonamento attivo e versione.
- La chiave di servizio e la chiave Anthropic stanno solo sul server.
- Gli utenti entrano con il nome utente; l'indirizzo interno è `<nome.utente>@utenti.haccp-salus.app` e non riceve email.

## Utenti

- Li crea LabService dall'**Area LabService** (menu laterale, solo per l'account `labservice`).
- La password generata si vede una volta sola. Al primo accesso l'utente deve sceglierne una sua (almeno 10 caratteri, lettere e numeri).
- Password dimenticata: LabService preme "Nuova password" sull'utente.
- Un'azienda sospesa non può più entrare né salvare; i dati restano.

## Salvataggio

- Ogni modifica viene salvata online dopo circa un secondo.
- Se due dispositivi salvano insieme, le modifiche vengono unite (lotti, registrazioni, fatture per voce). Se toccano lo stesso campo, vince l'ultimo che salva.
- Senza connessione le modifiche restano sul telefono e partono appena la rete torna.

## Cose da fare a mano nella dashboard di Supabase

1. Authentication → Sign In / Providers → disattivare "Allow new users to sign up".
2. Edge Functions → Secrets → `ANTHROPIC_API_KEY` = chiave Anthropic (console.anthropic.com).
3. Prima di andare in produzione: piano Pro (backup giornalieri) e trasferimento del progetto all'organizzazione di LabService.

## Prossimi passi (fase 2)

Stripe (abbonamento e blocco automatico), notifiche push (richiedono manifest e service worker), lettura dei file XML della fattura elettronica.
