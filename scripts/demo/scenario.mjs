// Scénario de démo — tous les montants sont fixés à la main et servent d'attendus.
export const SOCIETE = {
  nom: "DEMO ATLAS NEGOCE SARL", ice: "002845761000083", if_fiscal: "52418796", rc: "487213",
  patente: "34567812", adresse: "45 Bd Zerktouni, Casablanca", tel: "0522 48 71 30",
};
export const CLIENTS = {
  MB: { nom: "MAROC BATIMENT SARL", ice: "001562398000045", if_fiscal: "40125876", adresse: "12 Rue Ibn Sina, Rabat" },
  OD: { nom: "OCEAN DISTRIBUTION SA", ice: "002193847000061", if_fiscal: "33872145", adresse: "Zone Industrielle, Agadir" },
  SL: { nom: "SAHARA LOGISTIQUE SARL", ice: "001874520000037", if_fiscal: "28457913", adresse: "Av. Mohammed V, Laayoune" },
  RA: { nom: "RIF AGRO SA", ice: "002567193000052", if_fiscal: "45781236", adresse: "Route de Fes, Meknes" },
};
// l = [désignation, quantité, PU HT, taux TVA]
export const FACTURES = [
  { num: "FA-2026-0101", date: "2026-09-02", ech: "2026-10-02", cli: "MB", mode: "Virement",
    l: [["Ciment CPJ45 - sac 50 kg", 200, 45, 20], ["Fer a beton HA12 - tonne", 1, 1000, 20]] },
  { num: "FA-2026-0102", date: "2026-09-05", ech: "2026-11-25", cli: "OD", mode: "Virement en 3 tranches",
    tranches: [["2026-09-25", 10000], ["2026-10-25", 10000], ["2026-11-25", 10000]],
    l: [["Carrelage gres 60x60 - m2", 500, 50, 20]] },
  { num: "FA-2026-0103", date: "2026-09-10", ech: "2026-10-10", cli: "SL", mode: "Virement",
    l: [["Palettes bois Europe", 80, 50, 20]] },
  { num: "FA-2026-0104", date: "2026-09-18", ech: "2026-10-18", cli: "SL", mode: "Virement",
    l: [["Film etirable 23 microns - rouleau", 130, 50, 20]] },
  { num: "FA-2026-0105", date: "2026-09-22", ech: "2026-10-22", cli: "RA", mode: "Virement",
    l: [["Kit irrigation goutte a goutte", 4, 2000, 20], ["Engrais NPK 15-15-15 - sac", 20, 100, 10]] },
  { num: "FA-2026-0106", date: "2026-10-01", ech: "2026-10-31", cli: "MB", mode: "Cheque",
    l: [["Brouette de chantier renforcee", 10, 300, 20]] },
  { num: "FA-2026-0107", date: "2026-10-06", ech: "2026-11-05", cli: "OD", mode: "Virement",
    l: [["Plinthes gres - ml", 300, 25, 20]] },
  { num: "FA-2026-0108", date: "2026-10-09", ech: "2026-11-08", cli: "RA", mode: "Virement",
    l: [["Tuyau PEHD 32 mm - rouleau 100 m", 5, 500, 20]] },
];
export const BANQUE = { nom: "ATTIJARIWAFA BANK", agence: "Agence Casa Zerktouni", rib: "007 780 0001234567890123 45" };
// [date, libellé, débit, crédit]
export const RELEVES = [
  { mois: "Septembre 2026", fichier: "Releve_2026-09.pdf", du: "2026-09-01", au: "2026-09-30", soldeInitial: 50000, ops: [
    ["2026-09-12", "VIR RECU MAROC BATIMENT SARL REF FA-2026-0101", 0, 12000],
    ["2026-09-18", "PRLV MAROC TELECOM FACTURE IAM 09/2026", 1200, 0],
    ["2026-09-25", "VIR RECU OCEAN DISTRIBUTION SA 1ERE TRANCHE FA-2026-0102", 0, 10000],
    ["2026-09-28", "VIR RECU SAHARA LOGISTIQUE REGL FA-2026-0103 FA-2026-0104", 0, 12600],
    ["2026-09-30", "FRAIS TENUE DE COMPTE", 50, 0],
    ["2026-09-30", "TVA S/COMMISSION", 5, 0],
  ] },
  { mois: "Octobre 2026", fichier: "Releve_2026-10.pdf", du: "2026-10-01", au: "2026-10-27", soldeInitial: 83345, ops: [
    ["2026-10-03", "VIR RECU RIF AGRO SA ACOMPTE FA-2026-0105", 0, 5000],
    ["2026-10-08", "REMISE CHEQUE N 4521876 MAROC BATIMENT", 0, 3600],
    ["2026-10-10", "PRLV ONEE ELECTRICITE 09/2026", 850, 0],
    ["2026-10-15", "VIR RECU OCEAN DISTRIBUTION SA FA-2026-0102 FA-2026-0107", 0, 19000],
    ["2026-10-20", "VIR RECU RIF AGRO SA SOLDE FA-2026-0105", 0, 6800],
    ["2026-10-27", "FRAIS TENUE DE COMPTE", 50, 0],
    ["2026-10-27", "TVA S/COMMISSION", 5, 0],
  ] },
];
export const r2 = (n) => Math.round(n * 100) / 100;
export function totaux(f) {
  const ht = r2(f.l.reduce((s, [, q, pu]) => s + q * pu, 0));
  const tva = r2(f.l.reduce((s, [, q, pu, t]) => s + q * pu * t / 100, 0));
  return { ht, tva, ttc: r2(ht + tva) };
}
