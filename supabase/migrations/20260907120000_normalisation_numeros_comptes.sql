-- ============================================================================
-- 20260907120000_normalisation_numeros_comptes.sql
--
-- Uniformise la LONGUEUR des numéros de comptes sur 8 chiffres.
--
-- ─── Le défaut ──────────────────────────────────────────────────────────────
-- La base portait trois longueurs à la fois, non par erreur de saisie mais par
-- couches successives :
--   • 4 chiffres — le PCM marocain de base (5141, 4458, 6141) ;
--   • 5 chiffres — les sous-comptes de TVA (44551, 34552) et de charges (61254) ;
--   • 8 chiffres — la comptabilité auxiliaire (44110005, 34210002) et la caisse
--     par défaut (51610000).
--
-- Mêlées, elles font de « 5141 » et « 51410000 » deux comptes DISTINCTS : deux
-- lignes de balance pour la même banque, deux postes dans un donut, et un export
-- vers Sage — qui exige une longueur fixe — qui en refuse une sur deux.
--
-- ─── La forme canonique ─────────────────────────────────────────────────────
-- Le PCM complété à DROITE par des zéros, sur 8 chiffres :
--     5141 -> 51410000     34552 -> 34552000     4458 -> 44580000
-- C'est la convention du plan comptable marocain, et celle que la comptabilité
-- auxiliaire suivait déjà : collectif 4411 + code « 0005 » = 44110005.
--
-- ─── Pourquoi c'est SÛR ─────────────────────────────────────────────────────
-- Tout le code applicatif DÉTECTE par racine et IMPUTE sur le sous-compte.
-- Compléter à droite préserve exactement cette lecture :
--   • `startsWith('4455')` reste vrai sur 44551000  -> TVA exigible, verrous OD ;
--   • `startsWith('3421')` / `startsWith('4411')`   -> lettrage, balance âgée ;
--   • la classe reste le premier chiffre            -> sous-totaux CGNC, bilan ;
--   • le collectif reste le préfixe de l'auxiliaire -> comptabilité auxiliaire.
-- Aucune comparaison stricte sur un numéro de compte n'existe dans le code
-- métier ; le test `src/lib/numero-compte.test.ts` verrouille cette propriété.
--
-- ─── Ce que la migration NE touche pas ──────────────────────────────────────
-- `pcm_reference` reste le référentiel PCM, dans sa forme COURTE : ses numéros
-- sont des clefs de nomenclature, pas des comptes mouvementés. La résolution des
-- intitulés fait le pont dans les deux sens (`intitulePcm` indexe les deux
-- formes), si bien que la table peut être normalisée plus tard sans rien casser.
--
-- IDEMPOTENTE : un compte déjà sur 8 chiffres (ou plus) n'est pas retouché, et
-- un numéro non purement numérique est laissé tel quel plutôt que corrompu par
-- un padding aveugle.
--
-- ⚠️  À APPLIQUER À LA MAIN dans le SQL editor Supabase
--     (cf. mémoire « migrations-manuelles-supabase » : ni CLI ni psql ici).
-- ============================================================================

begin;

-- ── Fonction canonique, réutilisable par les triggers et les scripts ────────
create or replace function public.normaliser_numero_compte(numero text)
returns text
language sql
immutable
as $$
  select case
    -- Vide ou non purement numérique : on ne touche à rien. Un code exotique
    -- conservé coûte moins cher qu'un code détruit.
    when numero is null then numero
    when btrim(numero) = '' then btrim(numero)
    when btrim(numero) !~ '^[0-9]+$' then btrim(numero)
    -- Déjà canonique (ou plus long) : le tronquer détruirait un code auxiliaire large.
    when length(btrim(numero)) >= 8 then btrim(numero)
    else rpad(btrim(numero), 8, '0')
  end
$$;

comment on function public.normaliser_numero_compte(text) is
  'Forme canonique d''un numéro de compte : 8 chiffres complétés à droite par des zéros (5141 -> 51410000). Miroir SQL de src/lib/numero-compte.ts.';

-- ── Écritures comptables ────────────────────────────────────────────────────
update public.ecritures_comptables
   set compte_numero = public.normaliser_numero_compte(compte_numero)
 where compte_numero is distinct from public.normaliser_numero_compte(compte_numero);

-- ── Plan comptable du dossier ───────────────────────────────────────────────
-- Le `where` protège d'une collision : si le dossier porte DÉJÀ le compte
-- normalisé (par exemple 5141 et 51410000 côte à côte), le padding violerait
-- l'unicité. Ces doublons se fusionnent à la main, dossier par dossier — les
-- soldes initiaux ne s'additionnent pas mécaniquement.
update public.comptes_comptables c
   set numero = public.normaliser_numero_compte(c.numero)
 where c.numero is distinct from public.normaliser_numero_compte(c.numero)
   and not exists (
     select 1 from public.comptes_comptables d
      where d.dossier_id = c.dossier_id
        and d.id <> c.id
        and d.numero = public.normaliser_numero_compte(c.numero)
   );

-- ── Filet : toute écriture future arrive canonique, quel que soit l'appelant ─
-- Le code normalise déjà au bord (insererPiece, schémas zod, import Excel, écrans
-- de saisie). Ce trigger est la ceinture : un script ancien, une console SQL ou
-- un client non mis à jour ne peuvent plus réintroduire une longueur mêlée.
create or replace function public.tg_normaliser_compte_numero()
returns trigger
language plpgsql
as $$
begin
  new.compte_numero := public.normaliser_numero_compte(new.compte_numero);
  return new;
end
$$;

drop trigger if exists trg_normaliser_compte_numero on public.ecritures_comptables;
create trigger trg_normaliser_compte_numero
  before insert or update of compte_numero on public.ecritures_comptables
  for each row execute function public.tg_normaliser_compte_numero();

commit;

-- ── Contrôle après application ──────────────────────────────────────────────
-- Doit rendre 8 (et rien d'autre) sur la colonne des écritures :
--   select distinct length(compte_numero) from public.ecritures_comptables
--    where compte_numero ~ '^[0-9]+$';
--
-- Doublons de plan comptable restés à fusionner à la main :
--   select dossier_id, public.normaliser_numero_compte(numero) as canonique,
--          count(*), string_agg(numero, ' / ')
--     from public.comptes_comptables
--    group by 1, 2 having count(*) > 1;
