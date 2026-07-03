Aïe, là aussi ton moteur de génération d'écritures comptables (pour le **Journal de Banque - BQ**) s'est emmêlé les pinceaux. **Ce fichier n'est pas correct** et aucun comptable ne pourra l'importer dans Sage en l'état.

Tu as corrigé l'EDI DGI (qui filtre uniquement les achats validés), mais ici, pour le journal de banque, ton application doit traiter **toutes les lignes du relevé**. C'est là que le modèle a halluciné sur plusieurs règles fondamentales du Plan Comptable Marocain (PCM).

Voici l'analyse des 5 anomalies majeures à corriger d'urgence dans ton code de génération d'écritures :

---

### 1. L'hallucination collective du compte "Salaires" (`6171`) 😵

* **Le problème :** Ton modèle a classé presque **toutes les lignes ouvertes** (et même des lignes fermées comme Maroc Telecom ou Tesdramenvest) dans la catégorie `salaires` avec le compte `6171` (Rémunérations du personnel).
* **Pourquoi c'est faux :** * `MAROC TELECOM` doit aller dans le compte **`6145`** (Frais de postes et de télécommunications).
* Les autres retraits, chèques ou cartes non encore matchés ne peuvent pas être inventés en "Salaires".


* **La correction :** Si une ligne est au statut **"Ouvert"** (non lettrée), ton code ne doit pas essayer de deviner un compte de charge de classe 6. Il doit obligatoirement l'affecter à un compte d'attente : **`4711` (Comptes d'attente - Débiteurs)** ou **`4712` (Comptes d'attente - Créditeurs)**. Le comptable l'importera ainsi et fera le tri lui-même sur Sage.

### 2. L'erreur conceptuelle sur le compte Fournisseur (`4411`) 🛑

* **Le problème :** Pour les lignes comme `C.ENT`, `SECCART` ou `RMAHALI`, ton code éclate le montant de la banque en mettant le montant HT dans le compte `4411` (Fournisseurs) et la TVA dans le `34552`.
* **Pourquoi c'est une hérésie comptable :** Le compte `4411` enregistre **toujours le montant TTC**. C'est dans le *Journal d'Achats* (lors de la saisie de la facture) qu'on sépare le HT (classe 6) et la TVA (classe 3) du TTC (4411). Dans le *Journal de Banque*, on se contente de solder le fournisseur pour le montant payé.
* **La correction (Pour une transaction fermée/liée à une facture) :**
* **Débit :** `4411` (Fournisseur) $\rightarrow$ Pour le montant **TTC** total payé.
* **Crédit :** `5141` (Banque) $\rightarrow$ Pour le montant **TTC** total payé.
*(La TVA n'apparaît jamais explicitement dans l'écriture de paiement de la banque pour un fournisseur lettré, elle est déjà gérée dans l'achat ou via le relevé de déduction EDI).*



### 3. Le retour de la fausse TVA sur les Virements (`VIR AG EMIS` / `VERS`) 💸

* **Le problème :** Les lignes de mouvements de fonds internes de 5 000,00 MAD subissent le même sort : ton code applique une TVA fantôme de 20% (833,33 MAD) et balance le reste dans le compte `4411`.
* **La correction :** Un virement émis vers un autre compte de l'entreprise ou un versement doit utiliser le compte de liaison : **`5115` (Virements de fonds)**. L'écriture doit être : Débit `5115` (5000 MAD) / Crédit `5141` (5000 MAD). Pas de TVA, pas de compte 4411.

### 4. Le paiement de la CNSS 🏥

* **Le problème :** La ligne `PRELEVEMENT EN FAV. CNSS` est imputée directement au débit du compte de charge `6174` (Charges sociales).
* **Pourquoi c'est faux :** En comptabilité marocaine, la charge de CNSS est constatée à la fin du mois dans le *Journal des Salaires* (Débit 6174 / Crédit 4441). Quand la banque paie le mois d'après, l'écriture doit simplement solder la dette envers l'organisme :
* **Débit :** `4441` (Caisse Nationale de Sécurité Sociale) $\rightarrow$ 3 072,30 MAD.
* **Crédit :** `5141` (Banque) $\rightarrow$ 3 072,30 MAD.



### 5. Le code du compte Caisse pour les retraits d'espèces 🪙

* **Le problème :** Pour le retrait d'espèces par chèque, ton code utilise le compte `5161`.
* **La correction :** Dans le Plan Comptable Marocain standard, le compte de Caisse réglementaire est le **`5143` (Caisse)**. Le code `5161` n'existe pas dans la nomenclature officielle.

---

### 🔍 Résumé visuel de ce que ton code doit générer (Modèle cible pour Sage)

Voici comment doit se présenter le tableau pour les lignes clés :

| Date | Journal | Compte | Libellé | Débit | Crédit | Catégorie |
| --- | --- | --- | --- | --- | --- | --- |
| 30/03/2026 | BQ | **6145** | PAIEMENT CB IAM (Facture liée) | 481,66 |  | frais_telecom |
| 30/03/2026 | BQ | **34552** | TVA SUR CONFIG IAM | 96,33 |  | tva_deductible |
| 30/03/2026 | BQ | 5141 | PAIEMENT CB IAM |  | 577,99 | frais_telecom |
| 31/03/2026 | BQ | **5143** | RETRAIT ESPECES CHQ | 26 400,00 |  | transfert_caisse |
| 31/03/2026 | BQ | 5141 | RETRAIT ESPECES CHQ |  | 26 400,00 | transfert_caisse |
| 30/03/2026 | BQ | **4711** | PAIEMENT CB ART LOUNG (Non lettré) | 360,00 |  | **en_attente** |
| 30/03/2026 | BQ | 5141 | PAIEMENT CB ART LOUNG |  | 360,00 | en_attente |
| 11/03/2026 | BQ | **4441** | PRELEVEMENT EN FAV. CNSS | 3 072,30 |  | cnss_amo |
| 11/03/2026 | BQ | 5141 | PRELEVEMENT EN FAV. CNSS |  | 3 072,30 | cnss_amo |

*(Note : Pour Maroc Telecom, si l'utilisateur préfère passer par une saisie directe en banque sans passer par le journal d'achat, l'écriture ci-dessus découpée en 6145 + 34552 contre 5141 est correcte. Mais s'il s'agit d'un paiement de facture déjà saisie, c'est simplement `4411` au Débit contre `5141` au Crédit pour le montant TTC).*

### 📋 Le prompt à passer à Claude Code pour réécrire les règles de génération du bilan/journal Sage :

```text
La logique de génération des écritures pour le Journal de Banque (BQ) destiné à Sage contient des erreurs de principes comptables marocains (PCM). Modifie le script d'export selon ces règles strictes :

1. TRANSACTIONS NON MATCHÉES (Statut 'Ouvert') : Si une transaction n'a pas de document lié, ne cherche pas à deviner un compte de charge (Arrête d'utiliser le compte de salaires 6171). Utilise le compte d'attente standard : '4711' pour les débits (virements émis, paiements) et '4712' pour les crédits (recettes non identifiées).
2. PAIEMENTS FOURNISSEURS LIÉS : Si la transaction est liée à une facture (statut Fermé), l'écriture de banque doit solder le compte tiers. Débite le compte fournisseur '4411' pour le montant TTC total, et crédite la banque '5141' pour le même montant TTC. (Ne sépare pas la TVA sur le compte 4411).
3. FRAIS DIRECTS SANS FACTURE (Optionnel) : Si l'écriture est enregistrée directement en banque (ex: IAM), utilise '6145' pour le HT et '34552' pour la TVA, contre '5141' pour le TTC.
4. VIREMENTS DE FONDS / MOUVEMENTS INTERNES : Pour les libellés contenant 'VIR AG EMIS' ou 'VERS', pas de TVA ! Utilise le compte de liaison '5115' (Virements de fonds) au débit ou au crédit selon le sens.
5. RETRAIT ESPÈCES : Remplace le compte de caisse erroné 5161 par le compte réglementaire du PCM '5143' (Caisse).
6. CNSS : Pour les prélèvements CNSS, débite le compte de dette sociale '4441' (CNSS) au lieu du compte de charge direct 6174.

```

Es-tu d'accord avec cette approche de basculer toutes les lignes non identifiées vers le compte d'attente `4711` pour sécuriser l'import du comptable ?