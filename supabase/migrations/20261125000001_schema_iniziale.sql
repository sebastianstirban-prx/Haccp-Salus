-- HACCP Salus: aziende, utenti, dati dell'app per azienda

create table public.aziende (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(nome) between 1 and 200),
  piva text, indirizzo text, referente text, settore text, telefono text, pec text, note text,
  attivo boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profili (
  user_id uuid primary key references auth.users(id) on delete cascade,
  azienda_id uuid not null references public.aziende(id) on delete restrict,
  username text not null unique check (username ~ '^[a-z0-9._-]{3,60}$'),
  nome text not null check (length(nome) between 1 and 120),
  descrizione text,
  admin boolean not null default false,
  must_change_pw boolean not null default true,
  attivo boolean not null default true,
  created_at timestamptz not null default now()
);
create index profili_azienda_idx on public.profili(azienda_id);

create table public.app_state (
  azienda_id uuid primary key references public.aziende(id) on delete cascade,
  data jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- copie precedenti (ultime 30 per azienda): protezione da sovrascritture sbagliate
create table public.app_state_storico (
  id bigint generated always as identity primary key,
  azienda_id uuid not null references public.aziende(id) on delete cascade,
  version integer not null,
  data jsonb not null,
  saved_at timestamptz not null,
  saved_by uuid
);
create index app_state_storico_az_idx on public.app_state_storico(azienda_id, id desc);

alter table public.aziende enable row level security;
alter table public.profili enable row level security;
alter table public.app_state enable row level security;
alter table public.app_state_storico enable row level security;

-- helper
create or replace function public.mia_azienda() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.azienda_id from public.profili p where p.user_id = auth.uid() and p.attivo
$$;
create or replace function public.sono_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.admin from public.profili p where p.user_id = auth.uid() and p.attivo), false)
$$;

-- lettura: ognuno vede solo la propria azienda; l'admin LabService vede l'elenco aziende e utenti
create policy aziende_lettura on public.aziende for select to authenticated
  using (id = (select public.mia_azienda()) or (select public.sono_admin()));
create policy profili_lettura on public.profili for select to authenticated
  using (azienda_id = (select public.mia_azienda()) or (select public.sono_admin()));
create policy stato_lettura on public.app_state for select to authenticated
  using (azienda_id = (select public.mia_azienda()));
-- nessuna scrittura diretta: si passa dalle funzioni qui sotto o dal server

-- salvataggio con controllo di versione: ritorna la nuova versione, -1 se un altro dispositivo ha salvato prima
create or replace function public.salva_stato(p_data jsonb, p_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare az uuid := public.mia_azienda(); v integer; old public.app_state%rowtype;
begin
  if az is null then raise exception 'non autorizzato' using errcode = '42501'; end if;
  if not exists (select 1 from public.aziende a where a.id = az and a.attivo) then
    raise exception 'abbonamento non attivo' using errcode = '42501';
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

create or replace function public.versione_stato() returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.version from public.app_state s where s.azienda_id = public.mia_azienda()), 0)
$$;

-- tutto quello che serve all'app dopo il login, in una chiamata
create or replace function public.mio_contesto() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'profilo', (select jsonb_build_object('username', p.username, 'nome', p.nome, 'descrizione', p.descrizione,
                 'admin', p.admin, 'must_change_pw', p.must_change_pw)
                from public.profili p where p.user_id = auth.uid() and p.attivo),
    'azienda', (select to_jsonb(a) - 'note' from public.aziende a where a.id = public.mia_azienda()),
    'colleghi', coalesce((select jsonb_agg(jsonb_build_object('username', c.username, 'nome', c.nome, 'descrizione', c.descrizione) order by c.nome)
                 from public.profili c where c.azienda_id = public.mia_azienda() and c.attivo), '[]'::jsonb),
    'versione', public.versione_stato()
  )
$$;

create or replace function public.password_cambiata() returns void
language sql security definer set search_path = '' as $$
  update public.profili set must_change_pw = false where user_id = auth.uid()
$$;

revoke all on function public.mia_azienda(), public.sono_admin(), public.salva_stato(jsonb, integer),
  public.versione_stato(), public.mio_contesto(), public.password_cambiata() from public, anon;
grant execute on function public.mia_azienda(), public.sono_admin(), public.salva_stato(jsonb, integer),
  public.versione_stato(), public.mio_contesto(), public.password_cambiata() to authenticated;

-- foto e file: cartella privata per azienda (percorso <azienda_id>/<file>)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('foto', 'foto', false, 10485760, array['image/jpeg','image/png','image/webp','image/gif','application/pdf'])
on conflict (id) do nothing;

create policy foto_lettura on storage.objects for select to authenticated
  using (bucket_id = 'foto' and (storage.foldername(name))[1] = (select public.mia_azienda())::text);
create policy foto_caricamento on storage.objects for insert to authenticated
  with check (bucket_id = 'foto' and (storage.foldername(name))[1] = (select public.mia_azienda())::text);
create policy foto_modifica on storage.objects for update to authenticated
  using (bucket_id = 'foto' and (storage.foldername(name))[1] = (select public.mia_azienda())::text);
create policy foto_eliminazione on storage.objects for delete to authenticated
  using (bucket_id = 'foto' and (storage.foldername(name))[1] = (select public.mia_azienda())::text);
