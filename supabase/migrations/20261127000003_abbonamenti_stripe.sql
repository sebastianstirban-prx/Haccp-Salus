-- HACCP Salus: abbonamento di ogni azienda cliente con Stripe.
-- pagamento = 'stripe': il cliente paga dall'app (prezzo e piano decisi da LabService per quella azienda,
--                       7 giorni di prova con carta, poi addebito automatico).
-- pagamento = 'esente': pagamento gestito da LabService fuori dall'app (default per le aziende già esistenti).
-- Le colonne sub_* sono una copia dello stato su Stripe, aggiornata dalla funzione "pagamenti"
-- (webhook di Stripe e controllo all'accesso).

alter table public.aziende
  add column if not exists pagamento text not null default 'esente',
  add column if not exists piano text,
  add column if not exists prezzo_cent integer,
  add column if not exists stripe_customer text,
  add column if not exists stripe_sub text,
  add column if not exists sub_stato text,
  add column if not exists sub_fine_periodo timestamptz,
  add column if not exists prova_fine timestamptz,
  add column if not exists prova_usata boolean not null default false,
  add column if not exists insoluto_dal timestamptz,
  add column if not exists sub_aggiornato timestamptz;

alter table public.aziende drop constraint if exists aziende_pagamento_chk;
alter table public.aziende add constraint aziende_pagamento_chk check (pagamento in ('stripe', 'esente'));
alter table public.aziende drop constraint if exists aziende_piano_chk;
alter table public.aziende add constraint aziende_piano_chk check (piano is null or piano in ('mensile', 'annuale'));
alter table public.aziende drop constraint if exists aziende_prezzo_chk;
alter table public.aziende add constraint aziende_prezzo_chk check (prezzo_cent is null or prezzo_cent between 100 and 10000000);

create index if not exists aziende_stripe_customer_idx on public.aziende (stripe_customer);
create index if not exists aziende_stripe_sub_idx on public.aziende (stripe_sub);

-- L'azienda può lavorare? Sospesa da LabService = no. Demo o pagamento esente = sì.
-- Con Stripe: abbonamento in prova o attivo; se un pagamento non riesce, 3 giorni di tolleranza.
create or replace function public.abbonamento_ok(p_az uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select a.attivo and (
      a.demo
      or a.pagamento = 'esente'
      or a.sub_stato in ('trialing', 'active')
      or (a.sub_stato in ('past_due', 'unpaid') and a.insoluto_dal is not null and now() < a.insoluto_dal + interval '3 days')
    )
    from public.aziende a where a.id = p_az
  ), false)
$$;
revoke all on function public.abbonamento_ok(uuid) from public, anon, authenticated;

-- Contesto dell'utente: in più dice se l'abbonamento permette di lavorare.
create or replace function public.mio_contesto()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'profilo', (select jsonb_build_object('username', p.username, 'nome', p.nome, 'descrizione', p.descrizione,
                 'admin', p.admin, 'must_change_pw', p.must_change_pw)
                from public.profili p where p.user_id = auth.uid() and p.attivo),
    'azienda', (select to_jsonb(a) - 'note' from public.aziende a where a.id = public.mia_azienda()),
    'abbonamento_ok', public.abbonamento_ok(public.mia_azienda()),
    'colleghi', coalesce((select jsonb_agg(jsonb_build_object('username', c.username, 'nome', c.nome, 'descrizione', c.descrizione) order by c.nome)
                 from public.profili c where c.azienda_id = public.mia_azienda() and c.attivo), '[]'::jsonb),
    'versione', public.versione_stato()
  )
$$;

-- Salvataggio: azienda sospesa -> "abbonamento non attivo"; abbonamento da pagare -> "pagamento richiesto".
create or replace function public.salva_stato(p_data jsonb, p_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare az uuid := public.mia_azienda(); v integer; old public.app_state%rowtype;
begin
  if az is null then raise exception 'non autorizzato' using errcode = '42501'; end if;
  if not exists (select 1 from public.aziende a where a.id = az and a.attivo) then
    raise exception 'abbonamento non attivo' using errcode = '42501';
  end if;
  if not public.abbonamento_ok(az) then
    raise exception 'pagamento richiesto' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'dati non validi'; end if;
  select * into old from public.app_state s where s.azienda_id = az for update;
  if not found then
    if coalesce(p_version, 0) <> 0 then return -1; end if;
    insert into public.app_state(azienda_id, data, version, updated_by) values (az, p_data, 1, auth.uid());
    return 1;
  end if;
  if old.version <> p_version then return -1; end if;
  insert into public.app_state_storico(azienda_id, version, data, saved_at, saved_by)
    values (az, old.version, old.data, old.updated_at, old.updated_by);
  delete from public.app_state_storico h where h.azienda_id = az
    and h.id not in (select h2.id from public.app_state_storico h2 where h2.azienda_id = az order by h2.id desc limit 30);
  update public.app_state s set data = p_data, version = old.version + 1, updated_at = now(), updated_by = auth.uid()
    where s.azienda_id = az returning s.version into v;
  return v;
end $$;
