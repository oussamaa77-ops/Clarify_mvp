-- ════════════════════════════════════════════════════════════════════════════
-- 20260909130000_ajouter_origine_avoir.sql
--
-- Autorise `paiements.origine = 'avoir'`.
--
-- ─── Ce que la contrainte actuelle empêche de dire ───────────────────────────
-- `paiements` est la source de vérité du reste dû depuis 20260710130000, et son
-- CHECK n'admet que trois origines : 'encaissement', 'lettrage', 'manuel'. Les
-- trois décrivent un MOUVEMENT D'ARGENT — une ligne de relevé, un encaissement
-- formel, une saisie au clavier.
--
-- Or une créance s'éteint aussi SANS que rien ne bouge : un avoir la ramène, en
-- tout ou partie, et le compte de tiers se solde. La table doit alors porter une
-- ligne — sinon la facture reste « partielle » alors que son 3421 est lettré et
-- soldé, et le rapprochement encours ⇄ restes dus tombe en défaut du montant de
-- l'avoir (constaté sur le dossier étalon : 2 400 MAD d'écart, R1 en FAIL).
--
-- Faute de valeur idoine, cette ligne était rangée en 'manuel', c'est-à-dire
-- déclarée « versement saisi à la main ». Rien ne la distinguait plus d'un
-- encaissement réel, sinon sa RÉFÉRENCE — une convention de nommage, que le
-- premier import venu peut ne pas respecter. Deux faits comptables différents
-- portaient la même étiquette :
--
--   • 'manuel' → de l'argent est entré, sans pièce bancaire rattachée ;
--   • 'avoir'  → aucun argent n'est entré, la créance a été ANNULÉE.
--
-- La différence n'est pas cosmétique. Un état de trésorerie qui somme les
-- règlements pour dire ce qui a été encaissé comptait l'avoir comme une recette.
--
-- ─── Pourquoi le rebuild n'y touche pas ──────────────────────────────────────
-- `synchroniser_paiements_dossier` efface et reconstruit les origines DÉRIVÉES
-- ('lettrage', 'encaissement') depuis `transactions_bancaires` et
-- `encaissements`. 'avoir' n'en fait pas partie, exactement comme 'manuel' :
-- elle ne dérive d'aucune pièce de trésorerie et survit donc au rapprochement.
-- C'est le comportement voulu — un avoir ne se redécouvre pas dans un relevé.
--
-- ─── Ce que la migration NE fait PAS ─────────────────────────────────────────
-- Elle ne requalifie AUCUNE ligne existante. Les imputations d'avoir déjà en
-- base restent en 'manuel' : les distinguer supposerait de deviner leur nature
-- d'après leur référence, et une reprise de données ne se fait pas à l'aveugle
-- dans un DDL. Sur la base auditée, la seule ligne concernée est celle du
-- dossier étalon, que `seed-golden-dossier.ts` réécrit à chaque semis.
--
-- Vérifié avant écriture : la contrainte s'appelle bien `paiements_origine_check`
-- (nom auto-généré par le CHECK en ligne de 20260710130000), et aucune ligne de
-- la base ne porte une origine hors des trois valeurs actuelles — l'élargir ne
-- peut donc invalider aucune donnée existante.
-- ════════════════════════════════════════════════════════════════════════════

-- L'ordre DROP puis ADD, et non un ALTER : PostgreSQL ne sait pas modifier une
-- contrainte CHECK en place. `IF EXISTS` rend la migration rejouable, et couvre
-- le cas où une reprise antérieure l'aurait déjà retirée.
ALTER TABLE public.paiements
  DROP CONSTRAINT IF EXISTS paiements_origine_check;

ALTER TABLE public.paiements
  ADD CONSTRAINT paiements_origine_check
  CHECK (origine IN ('encaissement', 'lettrage', 'manuel', 'avoir'));

COMMENT ON COLUMN public.paiements.origine IS
  'Ce qui a éteint la créance ou la dette. '
  '''encaissement'' / ''lettrage'' : dérivées d''une pièce de trésorerie, RECONSTRUITES '
  'par synchroniser_paiements_dossier. '
  '''manuel'' : versement saisi à la main, sans pièce bancaire rattachée — de l''argent '
  'est bien entré. '
  '''avoir'' : la créance a été ANNULÉE par un avoir, AUCUN argent n''a circulé. '
  'Ne jamais compter une ligne ''avoir'' comme une recette de trésorerie.';
