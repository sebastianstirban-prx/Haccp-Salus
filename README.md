# HACCP Salus · LabService srls

Web-app per l'autocontrollo HACCP: temperature, sanificazioni, controllo merci con lettura delle fatture da foto, magazzino, lotti e tracciabilità (dal lotto della materia prima ai clienti, con rapporto PDF per il richiamo), documentazione e piano di campionatura, audit con la checklist OSA della Regione Campania.
Ogni azienda cliente ha i suoi dati, separati dalle altre; gli utenti li crea LabService dall'app.

Realizzata da Proxima Studio.

---

## Struttura del repository

```
.
├── web/                            La cartella da pubblicare su Netlify, così com'è
│   ├── index.html                  L'app completa (HTML + CSS + JavaScript in un solo file, senza build)
│   ├── manifest.webmanifest        Nome e icone quando l'app si aggiunge alla schermata Home (Android)
│   ├── apple-touch-icon.png        Icona per "Aggiungi a Home" su iPhone e iPad (180×180, fondo bianco)
│   ├── icon-192.png, icon-512.png  Icone Android; icon-maskable-512.png con margini per il ritaglio rotondo
│   └── favicon-32.png, favicon-64.png  Icona nella scheda del browser
├── supabase/
│   ├── migrations/                 Schema del database, da eseguire in ordine
│   │   ├── 20261125000001_schema_iniziale.sql
│   │   └── 20261125000002_azienda_demo_flag.sql
│   └── functions/                  Funzioni lato server (Edge Functions, Deno)
│       ├── admin-utenti/index.ts   Area LabService: aziende, utenti, password, sospensioni, piano e prezzo
│       ├── leggi-fattura/index.ts  Lettura con l'IA di fatture ed etichette da foto
│       └── pagamenti/index.ts      Abbonamenti Stripe: checkout, portale clienti, webhook, stato
├── docs/
│   ├── HACCP-Salus-guida-rapida.pdf   Manuale d'uso breve per gli utenti
│   └── HACCP-Salus-scheda-tecnica.pdf Scheda tecnica: architettura, linguaggi, librerie, servizi, sicurezza
└── README.md
```

## Come funziona

| Pezzo | Dove gira | Cosa fa |
|---|---|---|
| `web/index.html` | Netlify (sito statico) | L'interfaccia. Login, schermate, registri PDF/Excel, fotocamera, codici a barre. |
| Database | Supabase, progetto `haccp-salus` (Francoforte) | `aziende`, `profili` (utenti), `app_state` (tutti i dati di un'azienda, con numero di versione), `app_state_storico` (ultime 30 versioni). |
| Deposito file | Supabase Storage, bucket privato `foto` | Foto e documenti, in una cartella per azienda: `<id azienda>/img/…` e `<id azienda>/doc/…`. |
| `admin-utenti` | Edge Function | Solo per utenti con `admin = true`: crea aziende e utenti, genera password, sospende e riattiva. |
| `leggi-fattura` | Edge Function | Manda la foto a Claude (Anthropic) e restituisce i dati della fattura o, con `tipo: "etichetta"`, dell'etichetta. |
| `pagamenti` | Edge Function | Abbonamenti con Stripe: pagina di pagamento, portale clienti (carta, fatture, disdetta), webhook che aggiorna lo stato. |

### Abbonamenti (Stripe)

- Ogni azienda cliente paga LabService dall'app. In Area LabService → Modifica dati si sceglie per ogni azienda: **pagamento con carta (Stripe)** oppure **gestito da LabService** (nessun pagamento in app), **piano mensile o annuale** e **prezzo** (IVA inclusa).
- Primo abbonamento: **7 giorni di prova** con la carta inserita subito; poi l'addebito parte da solo. Una seconda prova non è prevista.
- Pagamento non riuscito: avviso in Home e **3 giorni di tolleranza**, poi l'app si blocca finché la carta non viene aggiornata. I dati restano.
- La regola sta nel database (`public.abbonamento_ok`): il salvataggio viene rifiutato anche se qualcuno aggira l'interfaccia.
- Stato in `aziende` (`sub_stato`, `prova_fine`, `sub_fine_periodo`, `insoluto_dal`…), aggiornato dal webhook di Stripe e a ogni accesso.
- Il webhook non usa il segreto di firma: la funzione rilegge ogni evento da Stripe con la chiave segreta, quindi un evento inventato non cambia nulla.
- Prodotto, portale e webhook su Stripe si creano da soli (Area LabService → Pagamenti Stripe → Verifica collegamento), sia in modalità di prova sia reale.
- Stripe emette ricevute; la **fattura elettronica SDI** resta a carico di LabService.

### Modalità dell'app

- **Online** (normale): pagina aperta da un sito. Login con Supabase, dati per azienda.
- **Demo locale**: aggiungere `?demo` all'indirizzo. Dati di esempio salvati solo nel browser, nessun server.
- **Anteprima claude.ai**: come la demo, usata per mostrare le modifiche durante lo sviluppo.

## Orientarsi nel codice di `web/index.html`

In cima al file c'è un commento con il funzionamento generale, la **mappa del file** e il **modello dei dati**. Ogni parte comincia con un titolo cercabile:

```
/* ---------- views ---------- */
/* ---------- online: Supabase (login, dati per azienda, foto e documenti) ---------- */
/* ---------- audit con la checklist universale OSA (Regione Campania) ---------- */
```

Le convenzioni principali:

- **Schermate**: una funzione `v*()` per schermata (`vHome`, `vTemp`, `vDocumenti`…), registrata nella mappa `V`. La navigazione usa l'hash dell'indirizzo (`#temperatura`, `#documenti`).
- **Dati**: tutto lo stato di un'azienda è nell'oggetto `S`. Dopo ogni modifica si chiama `save()`; online il salvataggio parte dopo circa un secondo.
- **Tasti**: `data-act="nome"` nell'HTML, gestito da `ACT['nome']`. **Moduli**: `data-form="nome"`, gestito da `FORMS['nome']`.
- **Fogli a scomparsa**: `openSheet(titolo, html)` e `closeSheet()`.
- **Allegati**: `filesBlock(chiave, titolo, testoTasto)`; la chiave dice a quale elemento appartengono (vedi `fileHost`).

Per aggiungere un tasto: `data-act="mio-tasto"` nell'HTML e `ACT['mio-tasto']=a=>{...}` nel codice.

## Pubblicare un aggiornamento

- **App**: trascinare l'intera cartella `web/` (index.html, manifest e icone) nella pagina Deploys del sito su Netlify. Se si carica solo `index.html`, le icone della schermata Home non si vedono.
- **Funzioni**: `supabase functions deploy admin-utenti` e `supabase functions deploy leggi-fattura` (Supabase CLI, collegata al progetto).
- **Database**: le migrazioni in `supabase/migrations` si applicano in ordine (`supabase db push`).

### Segreti (Supabase → Edge Functions → Secrets)

| Nome | Obbligatorio | A cosa serve |
|---|---|---|
| `ANTHROPIC_API_KEY` | sì | Lettura di fatture ed etichette con l'IA. |
| `CLAUDE_MODEL` | no | Modello da usare; se manca, `claude-sonnet-5-5`. |
| `STRIPE_SECRET_KEY` | per i pagamenti | Abbonamenti Stripe. `sk_test_…` per le prove, `sk_live_…` per incassare davvero. |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` li fornisce Supabase da sé. Le chiavi segrete non vanno mai nel codice: in `index.html` c'è solo la chiave pubblica di Supabase, che può stare lì perché i permessi li decidono le regole del database.

## Sicurezza

- Ogni utente legge solo i dati della propria azienda (regole RLS di Postgres e del deposito file), verificato con un utente di un'altra azienda.
- I client non scrivono direttamente nelle tabelle: passano da funzioni che controllano azienda, abbonamento attivo e versione dei dati.
- Gli utenti entrano con il nome utente; l'indirizzo interno è `<nome.utente>@utenti.haccp-salus.app` e non riceve email.
- Al primo accesso l'utente deve scegliere una password sua (almeno 10 caratteri, lettere e numeri).
- Gli account li crea solo LabService: in Supabase la registrazione libera va tenuta disattivata (Authentication → Sign In / Providers → "Allow new users to sign up" spento).

## Salvataggio e sincronizzazione

- Se due dispositivi salvano insieme, le modifiche vengono unite elemento per elemento (lotti, registrazioni, fatture). Se toccano lo stesso campo, vale l'ultimo salvataggio.
- Senza connessione le modifiche restano sul dispositivo e partono appena la rete torna.
- Le ultime 30 versioni dei dati di ogni azienda restano nello storico sul server.



## Prima della produzione

- Piano Supabase Pro (backup giornalieri).
- Trasferimento del progetto Supabase e del repository a LabService.
- Disattivare gli utenti di prova dall'Area LabService.
- Verificare che la registrazione libera sia disattivata in Supabase.
