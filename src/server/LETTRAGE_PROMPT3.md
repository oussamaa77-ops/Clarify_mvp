Dans la section Clients (dossiers.$dossierId.clients.tsx), quand un client est sélectionné, ajoute un panneau latéral ou une page détail avec deux zones :

## ZONE 1 — KPIs + Charts (données calculées depuis Supabase, zéro appel Groq)
Calcule et affiche en temps réel :
- Encours total (somme reste_a_payer des factures status='validee')
- CA total (somme montant_ttc toutes factures)
- Nombre de factures : total / payées / en attente / en retard (date_echeance < aujourd'hui ET reste_a_payer > 0)
- Délai moyen de paiement en jours
- Top 3 mois de facturation

Charts (utilise recharts déjà installé) :
- BarChart : CA mensuel des 12 derniers mois
- PieChart : répartition Payées / En attente / En retard
- LineChart : évolution de l'encours sur 6 mois

## ZONE 2 — Liste des factures du client
Tableau avec colonnes : numero_facture, date, date_echeance, montant_ttc, reste_a_payer, statut (badge coloré)
- Clic sur une ligne ? ouvre la facture en consultation (vue existante) + affiche le PDF stocké dans Supabase Storage
- Tri par date_echeance DESC par défaut

## RÈGLES
- Zéro nouveau composant UI : utilise shadcn/ui existant (Card, Badge, Table, Tabs)
- Zéro appel API externe
- Données en temps réel via React Query + Supabase existants
- Ne touche à aucun autre fichier