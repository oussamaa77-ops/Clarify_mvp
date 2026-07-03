## MISSION
1. Restaure banque.tsx à son état EXACT avant cette session (supprime tout ce que tu as ajouté).
2. Ensuite, ajoute UNIQUEMENT la fonctionnalité de matching multi-factures décrite ci-dessous.
3. Ne touche à aucun autre fichier sauf banque.tsx et factures.functions.ts.

## RÈGLE ABSOLUE
- Zéro duplication de transactions dans l'affichage
- Zéro hallucination de matching (ne jamais associer une transaction à une facture si le critère n'est pas rempli)
- Zéro paiement partiel : une facture est soit soldee soit non touchée
- Conserver toute la logique existante du code

## SEUL CAS GÉRÉ : Paiement groupé multi-factures
Déclencher UNIQUEMENT si :
S(reste_a_payer des factures sélectionnées) = montant_transaction ± 1 MAD

### Algorithme (Knapsack 0/1 exact)
Applique dans cet ordre de priorité :
1. Nom société client/fournisseur cité dans le libellé bancaire ? filtre d'abord sur ce tiers
2. Date d'échéance vs date transaction : privilégie factures dont échéance = date_transaction + 60j
3. Knapsack 0/1 sur reste_a_payer pour trouver le sous-ensemble exact (± 1 MAD)
4. Si plusieurs solutions knapsack : applique FIFO (date_echeance ASC)
5. Si aucune combinaison exacte trouvée ? ne rien afficher, laisser la ligne sans matching

### Résultat si match trouvé
- Badge vert "Multi-factures exact" sur la ligne transaction
- Panneau détail : liste des factures matchées avec numero_facture + montant + statut "Soldée"
- Bouton "Valider" ? écriture en base uniquement après clic humain
- Si match non trouvé ? aucun badge, aucune suggestion

## CE QUI NE CHANGE PAS
- Matching 1 transaction ? 1 facture existant : ne pas y toucher
- Aucun appel Groq/IA supplémentaire : algorithme purement calculatoire
- Structure des composants UI existants : ne pas restructurer