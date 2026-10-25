-- ============================================================================
-- 20261024120000_conformite_cgnc.sql
--
-- Mise en conformité du plan de comptes avec le CGNC (plan comptable marocain).
--
-- ─── Ce que la migration corrige ────────────────────────────────────────────
--   1. TRIGGER sync_ecriture_contrepartie — ses exclusions comparaient le compte
--      à '5141', '34552', '44551' par ÉGALITÉ. Depuis la normalisation sur 8
--      chiffres (20260907120000) les comptes valent '51410000', '34552000'… :
--      plus aucune exclusion ne jouait, et un lettrage / délettrage écrasait la
--      ligne de BANQUE et la ligne de TVA par le compte du tiers. La détection
--      se fait désormais par RACINE, et le compte d'attente est 3497 / 4497.
--
--   2. RENUMÉROTATION des comptes hors CGNC produits par l'application, sur
--      l'exercice OUVERT seulement (les exercices clos sont intangibles) :
--        4711 → 3497  Comptes transitoires ou d'attente – débiteurs
--        4712 → 4497  Comptes transitoires ou d'attente – créditeurs
--                     (au CGNC, la rubrique 47 porte les écarts de conversion)
--        4191 → 4421  Clients – avances et acomptes reçus (419 = plan français)
--        6347 → 61473 Frais et commissions sur services bancaires (634 n'existe pas)
--        61241 → 61223 Achats de combustibles (6124 = variation des stocks)
--        4443 → 44525 pour l'IR retenu sur salaires (4443 = caisses de retraite)
--
--   3. RÉFÉRENTIEL pcm_reference — intitulés faux corrigés (4452, 4453, 4457,
--      4445, 4443, 4456, 5143, 5146, 7126, 7127…), comptes manquants ajoutés
--      (3453, 3497, 4421, 44525, 4455, 4497, 5115, 61223, 61251, 61678, 1189…),
--      numéros hors CGNC retirés (4191, 4197, 3441, 4419, 6347, 6313).
--
-- ─── Sûreté ─────────────────────────────────────────────────────────────────
--   • Une table de sauvegarde garde l'ancien numéro de chaque écriture modifiée.
--   • Les intitulés des plans de dossier ne sont réécrits que s'ils portent
--     encore l'intitulé FAUX d'origine : une saisie de l'utilisateur est préservée.
--   • Rejouable : chaque UPDATE ne touche que ce qui porte encore l'ancien numéro.
--
-- ⚠️  À APPLIQUER À LA MAIN dans le SQL editor Supabase, après relecture.
--     Ajuster `debut_exercice_ouvert` si l'exercice 2026 n'est pas l'exercice ouvert.
-- ============================================================================

begin;

-- ── 0. Paramètre : premier jour de l'exercice ouvert ────────────────────────
create temporary table _cgnc_param on commit drop as
  select date '2026-01-01' as debut_exercice_ouvert;

-- ── 1. Sauvegarde ───────────────────────────────────────────────────────────
create table if not exists public.backup_conformite_cgnc_20261024 (
  ecriture_id     text primary key,   -- id::text : indépendant du type de la clé
  ancien_compte   text not null,
  nouveau_compte  text not null,
  sauvegarde_le   timestamptz not null default now()
);

-- Table de correspondance : préfixe ancien → préfixe nouveau (forme 8 chiffres).
create temporary table _cgnc_renum (ancien text, nouveau text, filtre_libelle text) on commit drop;
insert into _cgnc_renum values
  ('4711',  '3497',  null),
  ('4712',  '4497',  null),
  ('4191',  '4421',  null),
  ('6347',  '61473', null),
  ('61241', '61223', null),
  ('4443',  '44525', 'IR/salaire%');   -- seules les lignes d'IR posées par la paie

insert into public.backup_conformite_cgnc_20261024 (ecriture_id, ancien_compte, nouveau_compte)
select e.id::text, e.compte_numero,
       -- Même longueur : on garde le suffixe (auxiliaire). Sinon (4443 → 44525),
       -- le compte est le compte principal seul, complété sur 8 chiffres.
       public.normaliser_numero_compte(case
         when length(r.ancien) = length(r.nouveau)
           then r.nouveau || substr(e.compte_numero, length(r.ancien) + 1)
         else r.nouveau
       end)
  from public.ecritures_comptables e
  join _cgnc_renum r on e.compte_numero like r.ancien || '%'
                    and (r.filtre_libelle is null or e.libelle like r.filtre_libelle)
 where e.date_ecriture >= (select debut_exercice_ouvert from _cgnc_param)
   -- 44525 tient sur 5 chiffres : un auxiliaire 4443xxxx ne se renumérote pas mécaniquement.
   and (r.ancien <> '4443' or e.compte_numero = '44430000')
on conflict (ecriture_id) do nothing;

update public.ecritures_comptables e
   set compte_numero = b.nouveau_compte
  from public.backup_conformite_cgnc_20261024 b
 where b.ecriture_id = e.id::text
   and e.compte_numero = b.ancien_compte;

-- Pièces justificatives et transactions : le compte proposé suit la même règle
-- (sans borne de date : ce n'est pas une écriture, c'est une imputation à venir).
update public.justificatifs set compte_pcm = '61223' where compte_pcm in ('61241', '61241000');
update public.justificatifs set compte_pcm = '61473' where compte_pcm in ('6347', '63470000');
update public.justificatifs set compte_pcm = '61678'
 where compte_pcm in ('6146', '61460000') and categorie_pcm = 'frais_douane';
update public.transactions_bancaires set compte_comptable = '61223' where compte_comptable in ('61241', '61241000');
update public.transactions_bancaires set compte_comptable = '61473' where compte_comptable in ('6347', '63470000');
update public.transactions_bancaires set compte_comptable = '61678'
 where compte_comptable in ('6146', '61460000') and categorie = 'frais_douane';
update public.transactions_bancaires set compte_comptable = '3497' where compte_comptable in ('4711', '47110000');
update public.transactions_bancaires set compte_comptable = '4497' where compte_comptable in ('4712', '47120000');

-- ── 2. Trigger de contrepartie : racines, 8 chiffres, attente 3497 / 4497 ──
create or replace function public.sync_ecriture_contrepartie()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_final text;   -- compte final (NULL = orphelin → compte d'attente 3497/4497)
begin
  if new.facture_id is not distinct from old.facture_id
     and new.justificatif_id is not distinct from old.justificatif_id then
    return new;
  end if;

  if new.facture_id is not null and new.document_type = 'facture_client' then
    v_final := '3421';
  elsif new.facture_id is not null and new.document_type = 'facture_fournisseur' then
    v_final := '4411';
  elsif new.justificatif_id is not null then
    select nullif(compte_pcm, '') into v_final
      from public.justificatifs where id = new.justificatif_id;
    if v_final is null or v_final !~ '^\d{4,}' then
      v_final := null;
    end if;
  else
    v_final := null;
  end if;

  -- Exclusions par RACINE (les comptes sont stockés sur 8 chiffres) :
  --   514 / 516  : la ligne de trésorerie, jamais une contrepartie ;
  --   3455 / 4455 / 3458 / 4458 : les lignes de TVA, qu'il ne faut pas reclasser en charge.
  update public.ecritures_comptables e
     set compte_numero = public.normaliser_numero_compte(
           coalesce(v_final, case when e.debit > 0 then '3497' else '4497' end))
   where e.transaction_id = new.id
     and e.journal_code = 'BQ'
     and left(e.compte_numero, 3) not in ('514', '516')
     and left(e.compte_numero, 4) not in ('3455', '4455', '3458', '4458');

  return new;
end $$;

drop trigger if exists trg_sync_ecriture_contrepartie on public.transactions_bancaires;
create trigger trg_sync_ecriture_contrepartie
  after update of facture_id, justificatif_id, document_type
  on public.transactions_bancaires
  for each row
  execute function public.sync_ecriture_contrepartie();

-- ── 3. Référentiel pcm_reference ────────────────────────────────────────────
insert into public.pcm_reference (numero, intitule, type_compte, classe) values
  ('1181',  'Résultats nets en instance d''affectation (solde créditeur)', 'capitaux', 1),
  ('1189',  'Résultats nets en instance d''affectation (solde débiteur)',  'capitaux', 1),
  ('3413',  'Fournisseurs - créances pour emballages et matériel à rendre', 'actif_circulant', 3),
  ('3417',  'Rabais, remises et ristournes à obtenir - avoirs non encore reçus', 'actif_circulant', 3),
  ('3451',  'État - subventions à recevoir', 'actif_circulant', 3),
  ('3453',  'État - acomptes sur impôts sur les résultats', 'actif_circulant', 3),
  ('3456',  'État - crédit de TVA (suivant déclarations)', 'actif_circulant', 3),
  ('3461',  'Associés - comptes d''apport en société', 'actif_circulant', 3),
  ('3463',  'Comptes courants des associés débiteurs', 'actif_circulant', 3),
  ('3497',  'Comptes transitoires ou d''attente - débiteurs', 'actif_circulant', 3),
  ('4413',  'Fournisseurs - retenues de garantie', 'passif_circulant', 4),
  ('4421',  'Clients - avances et acomptes reçus sur commandes en cours', 'passif_circulant', 4),
  ('4425',  'Clients - dettes pour emballages et matériel consignés', 'passif_circulant', 4),
  ('4427',  'Rabais, remises et ristournes à accorder - avoirs à établir', 'passif_circulant', 4),
  ('4441',  'Caisse nationale de la sécurité sociale (CNSS)', 'passif_circulant', 4),
  ('4443',  'Caisses de retraite', 'passif_circulant', 4),
  ('4445',  'Mutuelles', 'passif_circulant', 4),
  ('4447',  'Charges sociales à payer', 'passif_circulant', 4),
  ('4452',  'État - impôts, taxes et assimilés', 'passif_circulant', 4),
  ('44525', 'État - IGR (IR retenu à la source)', 'passif_circulant', 4),
  ('4453',  'État - impôts sur les résultats', 'passif_circulant', 4),
  ('4455',  'État - TVA facturée', 'passif_circulant', 4),
  ('44551', 'État - TVA facturée (exigible)', 'passif_circulant', 4),
  ('4456',  'État - TVA due (suivant déclarations)', 'passif_circulant', 4),
  ('4457',  'État - impôts et taxes à payer', 'passif_circulant', 4),
  ('4458',  'État - autres comptes créditeurs', 'passif_circulant', 4),
  ('4461',  'Associés - capital à rembourser', 'passif_circulant', 4),
  ('4463',  'Comptes courants des associés créditeurs', 'passif_circulant', 4),
  ('4497',  'Comptes transitoires ou d''attente - créditeurs', 'passif_circulant', 4),
  ('5111',  'Chèques à encaisser ou à l''encaissement', 'tresorerie', 5),
  ('5113',  'Effets à encaisser ou à l''encaissement', 'tresorerie', 5),
  ('5115',  'Virements de fonds', 'tresorerie', 5),
  ('5143',  'Trésorerie Générale', 'tresorerie', 5),
  ('5146',  'Chèques postaux', 'tresorerie', 5),
  ('5148',  'Autres établissements financiers et assimilés (soldes débiteurs)', 'tresorerie', 5),
  ('61223', 'Achats de combustibles', 'charges', 6),
  ('61251', 'Achats de fournitures non stockables (eau, électricité)', 'charges', 6),
  ('61473', 'Frais et commissions sur services bancaires', 'charges', 6),
  ('61671', 'Droits d''enregistrement et de timbre', 'charges', 6),
  ('61678', 'Autres impôts, taxes et droits assimilés', 'charges', 6),
  ('6148',  'Autres charges externes des exercices antérieurs', 'charges', 6),
  ('6181',  'Jetons de présence', 'charges', 6),
  ('7111',  'Ventes de marchandises au Maroc', 'produits', 7),
  ('7125',  'Ventes de services produits à l''étranger', 'produits', 7),
  ('7126',  'Redevances pour brevets, marques, droits et valeurs similaires', 'produits', 7),
  ('7127',  'Ventes de produits accessoires', 'produits', 7),
  ('7181',  'Jetons de présence reçus', 'produits', 7),
  ('7321',  'Revenus des titres de participation', 'produits', 7),
  ('7388',  'Intérêts et autres produits financiers des exercices antérieurs', 'produits', 7),
  ('7513',  'Produits des cessions des immobilisations corporelles', 'produits', 7)
on conflict (numero) do update
  set intitule = excluded.intitule,
      type_compte = excluded.type_compte,
      classe = excluded.classe;

-- Numéros hors CGNC : retirés du référentiel (les plans de dossier qui les
-- portent les gardent — un compte mouvementé ne disparaît pas — mais aucun
-- nouveau dossier ne les recevra plus).
delete from public.pcm_reference where numero in ('4191', '4197', '3441', '4419', '6347', '6313');

-- ── 4. Plans de dossier : intitulés faux d'origine, comptes manquants ───────
create temporary table _cgnc_libelles (numero text, ancien text) on commit drop;
insert into _cgnc_libelles values
  ('3451', 'État - acomptes sur impôts sur les résultats'),
  ('3461', 'Comptes d''associés débiteurs'),
  ('4443', 'État - impôt sur le revenu (IR)'),
  ('4445', 'État - impôts, taxes et assimilés'),
  ('4452', 'État - TVA facturée'),
  ('4453', 'État - TVA due'),
  ('4456', 'État - crédit de TVA / TVA due'),
  ('4457', 'État - impôts sur les résultats'),
  ('4461', 'Comptes d''associés créditeurs'),
  ('5143', 'Trésorerie - chèques et valeurs à encaisser'),
  ('5146', 'Chèques et valeurs à encaisser'),
  ('6148', 'Autres charges externes'),
  ('6181', 'Autres charges d''exploitation'),
  ('7126', 'Ventes de produits accessoires'),
  ('7127', 'Ventes de services produits à l''étranger'),
  ('7181', 'Autres produits d''exploitation');

update public.comptes_comptables c
   set intitule = p.intitule
  from _cgnc_libelles l
  join public.pcm_reference p on p.numero = l.numero
 where public.normaliser_numero_compte(c.numero) = public.normaliser_numero_compte(l.numero)
   and c.intitule = l.ancien;

-- Comptes du référentiel absents d'un dossier (forme canonique 8 chiffres).
insert into public.comptes_comptables (dossier_id, numero, intitule, type_compte)
select d.id, public.normaliser_numero_compte(p.numero), p.intitule, p.type_compte
  from public.dossiers d
 cross join public.pcm_reference p
on conflict (dossier_id, numero) do nothing;

commit;

-- ── Contrôles après application ─────────────────────────────────────────────
-- Écritures renumérotées, par ancien → nouveau compte :
--   select left(ancien_compte, 5), left(nouveau_compte, 5), count(*)
--     from public.backup_conformite_cgnc_20261024 group by 1, 2 order by 1;
--
-- Plus aucun compte hors CGNC sur l'exercice ouvert (doit rendre 0 ligne) :
--   select compte_numero, count(*) from public.ecritures_comptables
--    where date_ecriture >= date '2026-01-01'
--      and (compte_numero like '4711%' or compte_numero like '4712%' or compte_numero like '4191%'
--           or compte_numero like '6347%' or compte_numero like '61241%')
--    group by 1;
--
-- TVA prélevée par la banque sur ses commissions, passée à tort au DÉBIT du 4456
-- (TVA due) au lieu du 34552 (TVA récupérable). NON corrigée automatiquement :
-- ces lignes appartiennent à des périodes déjà déclarées. À régulariser par
-- l'expert-comptable (OD de régularisation REGUL-TVA-<période>) :
--   select e.date_ecriture, e.libelle, e.debit, e.reference_piece
--     from public.ecritures_comptables e
--     join public.transactions_bancaires t on t.id = e.transaction_id
--    where e.journal_code = 'BQ' and e.compte_numero like '4456%' and e.debit > 0
--      and t.libelle ~* '\mT\.?V\.?A\M.*(COMM|FRAIS|AGIOS|TENUE)|(COMM|FRAIS|AGIOS|TENUE).*\mT\.?V\.?A\M'
--    order by 1;
--
-- Crédits de TVA historiques restés en solde DÉBITEUR du 4456 (avant le 3456) :
-- toujours lus comme crédit reportable par l'application ; à transférer au 3456
-- par OD si l'expert le souhaite :
--   select sum(debit) - sum(credit) as solde_4456 from public.ecritures_comptables
--    where compte_numero like '4456%';
