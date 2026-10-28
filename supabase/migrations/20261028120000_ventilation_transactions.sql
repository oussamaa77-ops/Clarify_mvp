-- ============================================================================
-- 20261028120000_ventilation_transactions.sql
--
-- UNE ligne de relevé qui règle PLUSIEURS factures.
--
-- Jusqu'ici une transaction bancaire ne portait qu'UN `facture_id`, et la table
-- `paiements` n'admettait qu'un paiement par transaction (index unique sur
-- transaction_id). Un virement « FA-0103 + FA-0104 » ne pouvait donc régler que
-- l'une des deux : l'autre restait impayée, et sa TVA en attente pour toujours.
--
-- La ventilation est la RÉPARTITION de la ligne entre les factures qu'elle règle.
-- Elle devient la source de vérité des paiements de la ligne :
--   • `ventilations_transaction` : une ligne par (transaction, facture), montant ;
--   • `paiements.ventilation_id` : le paiement dérivé de chaque ventilation, avec
--     transaction_id NULL — l'index unique historique reste donc intact et la
--     RPC lier_transaction (un pour un) n'est pas modifiée ;
--   • `synchroniser_paiements_dossier` reconstruit les paiements depuis les
--     ventilations, et ignore le `facture_id` d'une ligne ventilée (il ne sert
--     plus qu'à l'affichage et au trigger de contrepartie 3421 / 4411) ;
--   • `ventiler_transaction` : la RPC atomique qui pose la répartition ;
--   • `delier_transaction` efface aussi la ventilation.
--
-- Les verrous de `trg_paiements_valider` (antériorité, non-dépassement cumulé)
-- s'appliquent à chaque paiement de ventilation comme à tout autre.
--
-- ⚠️  À APPLIQUER À LA MAIN dans le SQL editor Supabase.
-- ============================================================================

begin;

-- ── 1. Table des ventilations ───────────────────────────────────────────────
create table if not exists public.ventilations_transaction (
  id                     uuid primary key default gen_random_uuid(),
  dossier_id             uuid not null references public.dossiers(id) on delete cascade,
  transaction_id         uuid not null references public.transactions_bancaires(id) on delete cascade,
  facture_id             uuid references public.factures(id) on delete cascade,
  facture_fournisseur_id uuid references public.factures_fournisseurs(id) on delete cascade,
  montant                numeric(15,2) not null check (montant > 0),
  created_at             timestamptz not null default now(),
  constraint ventilations_une_seule_facture
    check ((facture_id is not null)::int + (facture_fournisseur_id is not null)::int = 1)
);

create unique index if not exists ventilations_uq_tx_facture
  on public.ventilations_transaction(transaction_id, facture_id) where facture_id is not null;
create unique index if not exists ventilations_uq_tx_facture_four
  on public.ventilations_transaction(transaction_id, facture_fournisseur_id) where facture_fournisseur_id is not null;
create index if not exists ventilations_dossier_idx on public.ventilations_transaction(dossier_id);

alter table public.ventilations_transaction enable row level security;
drop policy if exists ventilations_acces_dossier on public.ventilations_transaction;
create policy ventilations_acces_dossier on public.ventilations_transaction
  using (public.has_dossier_access(auth.uid(), dossier_id))
  with check (public.has_dossier_access(auth.uid(), dossier_id));

-- ── 2. Paiements dérivés d'une ventilation ──────────────────────────────────
alter table public.paiements
  add column if not exists ventilation_id uuid
    references public.ventilations_transaction(id) on delete cascade;
create unique index if not exists paiements_uq_ventilation
  on public.paiements(ventilation_id) where ventilation_id is not null;

-- ── 3. `ventiler_transaction` ───────────────────────────────────────────────
-- p_lignes : [{"facture_id": "...", "montant": 12.34}, …] — factures CLIENT pour
-- une ligne au crédit, FOURNISSEUR pour une ligne au débit (p_kind).
-- La somme ne peut pas dépasser le montant de la ligne ; un reliquat reste au
-- compte d'attente (3497 / 4497) côté grand livre.
create or replace function public.ventiler_transaction(
  p_tx_id  uuid,
  p_kind   text,
  p_lignes jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx       record;
  v_ligne    jsonb;
  v_facture  uuid;
  v_montant  numeric;
  v_total    numeric := 0;
  v_principal uuid;
  v_max      numeric := -1;
  v_vid      uuid;
  v_emission date;
  v_numero   text;
begin
  if p_kind not in ('client', 'fournisseur') then
    raise exception 'Sens de ventilation inconnu : %', p_kind using errcode = 'check_violation';
  end if;

  select t.id, t.dossier_id, abs(t.montant) as montant, t.date_operation, t.statut
    into v_tx
    from public.transactions_bancaires t where t.id = p_tx_id
    for update;
  if not found then
    raise exception 'Ligne de relevé % introuvable.', p_tx_id using errcode = 'no_data_found';
  end if;
  perform public.exiger_acces_dossier(v_tx.dossier_id);

  if jsonb_typeof(p_lignes) <> 'array' or jsonb_array_length(p_lignes) = 0 then
    raise exception 'Ventilation vide.' using errcode = 'check_violation';
  end if;

  -- Contrôles AVANT toute écriture : dossier, antériorité, total.
  for v_ligne in select * from jsonb_array_elements(p_lignes) loop
    v_facture := (v_ligne->>'facture_id')::uuid;
    v_montant := round((v_ligne->>'montant')::numeric, 2);
    if v_montant is null or v_montant <= 0 then
      raise exception 'Montant de ventilation invalide pour %.', v_facture using errcode = 'check_violation';
    end if;
    if p_kind = 'client' then
      perform 1 from public.factures f where f.id = v_facture and f.dossier_id = v_tx.dossier_id;
    else
      perform 1 from public.factures_fournisseurs f where f.id = v_facture and f.dossier_id = v_tx.dossier_id;
    end if;
    if not found then
      raise exception 'Facture % introuvable dans le dossier de la ligne de relevé.', v_facture
        using errcode = 'insufficient_privilege';
    end if;
    select e.date_emission, e.numero into v_emission, v_numero
      from public.emission_facture(v_facture, p_kind) e;
    if v_tx.date_operation is not null and v_emission is not null and v_tx.date_operation < v_emission then
      raise exception 'Ligne de relevé du % antérieure à la facture % (%) : elle ne peut pas la régler.',
        v_tx.date_operation, coalesce(v_numero, v_facture::text), v_emission
        using errcode = 'check_violation';
    end if;
    v_total := v_total + v_montant;
    if v_montant > v_max then v_max := v_montant; v_principal := v_facture; end if;
  end loop;

  if v_total > v_tx.montant + 0.01 then
    raise exception 'Ventilation de % pour une ligne de % : la répartition dépasse le montant de la ligne.',
      v_total, v_tx.montant using errcode = 'check_violation';
  end if;

  -- Remplacement intégral : ancien paiement « un pour un » et ancienne ventilation.
  delete from public.paiements where transaction_id = p_tx_id;
  delete from public.ventilations_transaction where transaction_id = p_tx_id;   -- cascade sur paiements

  for v_ligne in select * from jsonb_array_elements(p_lignes) loop
    v_facture := (v_ligne->>'facture_id')::uuid;
    v_montant := round((v_ligne->>'montant')::numeric, 2);
    insert into public.ventilations_transaction
      (dossier_id, transaction_id, facture_id, facture_fournisseur_id, montant)
    values (v_tx.dossier_id, p_tx_id,
            case when p_kind = 'client' then v_facture end,
            case when p_kind = 'fournisseur' then v_facture end,
            v_montant)
    returning id into v_vid;
    insert into public.paiements
      (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, ventilation_id, reference)
    values (v_tx.dossier_id,
            case when p_kind = 'client' then v_facture end,
            case when p_kind = 'fournisseur' then v_facture end,
            v_montant, coalesce(v_tx.date_operation, current_date), 'lettrage', v_vid,
            'VENT:' || p_tx_id::text);
  end loop;

  -- La ligne est rapprochée ; son facture_id (la plus grosse part) sert à
  -- l'affichage et au trigger de contrepartie, qui la passe au 3421 / 4411.
  update public.transactions_bancaires
     set facture_id = v_principal,
         justificatif_id = null,
         document_type = case when p_kind = 'client' then 'facture_client' else 'facture_fournisseur' end,
         statut = case when statut = 'cloture' then 'cloture' else 'ferme' end,
         rapproche = true
   where id = p_tx_id;

  return true;
end $$;

revoke execute on function public.ventiler_transaction(uuid, text, jsonb) from public, anon;
grant execute on function public.ventiler_transaction(uuid, text, jsonb) to authenticated, service_role;

-- ── 4. `delier_transaction` : efface aussi la ventilation ───────────────────
create or replace function public.delier_transaction(p_tx_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dossier_tx uuid;
begin
  select t.dossier_id into v_dossier_tx from public.transactions_bancaires t where t.id = p_tx_id;
  if found then
    perform public.exiger_acces_dossier(v_dossier_tx);
  end if;

  delete from public.paiements where transaction_id = p_tx_id;
  delete from public.ventilations_transaction where transaction_id = p_tx_id;   -- cascade sur paiements
  update public.transactions_bancaires
     set facture_id = null, justificatif_id = null, document_type = null, rapproche = false,
         statut = case when statut = 'cloture' then 'cloture' else 'ouvert' end
   where id = p_tx_id;
  return true;
end $$;

revoke execute on function public.delier_transaction(uuid) from public, anon;
grant execute on function public.delier_transaction(uuid) to authenticated, service_role;

-- ── 5. `synchroniser_paiements_dossier` : les ventilations d'abord ──────────
create or replace function public.synchroniser_paiements_dossier(p_dossier uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.exiger_acces_dossier(p_dossier);

  delete from public.paiements
   where dossier_id = p_dossier
     and origine in ('lettrage','encaissement');

  -- Lignes VENTILÉES : un paiement par part.
  insert into public.paiements
    (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, ventilation_id, reference)
  select v.dossier_id, v.facture_id, v.facture_fournisseur_id, v.montant,
         coalesce(t.date_operation, current_date), 'lettrage', v.id, 'VENT:' || t.id::text
    from public.ventilations_transaction v
    join public.transactions_bancaires t on t.id = v.transaction_id
   where v.dossier_id = p_dossier;

  -- Lignes « un pour un », à l'exclusion des lignes ventilées et de celles qui
  -- PRÉCÈDENT la facture qu'elles prétendent régler.
  insert into public.paiements
    (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, transaction_id)
  select t.dossier_id,
         case when t.document_type = 'facture_fournisseur' then null else t.facture_id end,
         case when t.document_type = 'facture_fournisseur' then t.facture_id else null end,
         abs(t.montant), coalesce(t.date_operation, current_date), 'lettrage', t.id
    from public.transactions_bancaires t
    cross join lateral public.emission_facture(
      t.facture_id,
      case when t.document_type = 'facture_fournisseur' then 'fournisseur' else 'client' end) e
   where t.dossier_id = p_dossier
     and t.facture_id is not null
     and abs(t.montant) > 0
     and not exists (select 1 from public.ventilations_transaction v where v.transaction_id = t.id)
     and (e.date_emission is null
          or coalesce(t.date_operation, current_date) >= e.date_emission);

  insert into public.paiements
    (dossier_id, facture_id, facture_fournisseur_id, montant, date_paiement, origine, encaissement_id, reference)
  select e.dossier_id, e.facture_id, e.facture_fournisseur_id, e.montant,
         coalesce(e.date_encaissement, e.created_at::date), 'encaissement', e.id, e.reference
    from public.encaissements e
    cross join lateral public.emission_facture(
      coalesce(e.facture_id, e.facture_fournisseur_id),
      case when e.facture_fournisseur_id is not null then 'fournisseur' else 'client' end) f
   where e.dossier_id = p_dossier
     and coalesce(e.valide, true) = true
     and e.montant > 0
     and (e.facture_id is not null or e.facture_fournisseur_id is not null)
     and (f.date_emission is null
          or coalesce(e.date_encaissement, e.created_at::date) >= f.date_emission);
end $$;

revoke execute on function public.synchroniser_paiements_dossier(uuid) from public, anon;
grant execute on function public.synchroniser_paiements_dossier(uuid) to authenticated, service_role;

commit;
