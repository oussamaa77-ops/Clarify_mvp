// ============================================================================
// Parcours complet : inscription → choix du plan → connexion, et quota de scans.
//
// Test 1 (UI, session vierge) : l'inscription en 2 étapes crée le compte AVEC le
//   plan choisi (rangé dans user_metadata), et la 1re connexion l'active puis
//   efface le code.
// Test 2 (UI, session e2e)    : le compteur de scans n'augmente QUE pour un
//   document réellement parti au LLM. Un re-scan (rejeu) et un document servi
//   par le cache OCR ne décomptent rien (release_scan_quota).
//
// Les deux tests nettoient derrière eux (utilisateur, cabinet, usage, cache).
// ============================================================================
import { test, expect } from "@playwright/test";
import { admin, resolveDossier } from "../helpers/supabase";
import { CONFIG } from "../helpers/config";

// ── Facture PDF synthétique (couche texte) ───────────────────────────────────
// > 300 caractères non-blancs, sinon le client bascule en OCR vision (image).
// `espaces` change les OCTETS et le texte BRUT sans changer le texte NORMALISÉ
// (le hash de cache ne garde que lettres+chiffres) → cache-hit sur un scan neuf.
function facturePdf(numero: string, espaces = false): Buffer {
  const pad = espaces ? "    " : "";
  const lines = [
    "SOCIETE ATLAS DISTRIBUTION SARL",
    "ICE : 001234567000078",
    "123 Boulevard Mohammed V, Casablanca, Maroc",
    "Telephone : 0522 44 55 66 - Email : contact@atlas-distribution.ma",
    "",
    `FACTURE N° ${numero}`,
    "Date : 12/06/2026        Echeance : 12/07/2026",
    "",
    "Client : CABINET COMPTA PRO SARL",
    "ICE : 002987654000045",
    "",
    "Designation                 Qte     PU HT        Total HT",
    "Ramettes papier A4           20      45,00         900,00",
    "Cartouches encre noire        5     320,00       1 600,00",
    "",
    "Total HT ................................ 2 500,00 DH",
    "TVA 20% ................................... 500,00 DH",
    "Total TTC ............................... 3 000,00 DH",
    "Mode de reglement : Virement bancaire",
  ].map((l) => l + pad);

  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let content = "BT\n/F1 11 Tf\n";
  let y = 800;
  for (const l of lines) { content += `1 0 0 1 50 ${y} Tm\n(${esc(l)}) Tj\n`; y -= 18; }
  content += "ET";
  const objs: Record<number, string> = {
    1: "<</Type /Catalog /Pages 2 0 R>>",
    2: "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    3: "<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>",
    4: `<</Length ${Buffer.byteLength(content, "latin1")}>>\nstream\n${content}\nendstream`,
    5: "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
  };
  let body = "%PDF-1.4\n";
  const offsets: Record<number, number> = {};
  for (let i = 1; i <= 5; i++) { offsets[i] = Buffer.byteLength(body, "latin1"); body += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  return Buffer.from(body + xref + `trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`, "latin1");
}

async function nbScans(cabinetId: string): Promise<number> {
  const { count, error } = await admin()
    .from("usage_records")
    .select("id", { count: "exact", head: true })
    .eq("cabinet_id", cabinetId);
  if (error) throw error;
  return count ?? 0;
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 1 — Inscription → 3 plans → connexion → plan activé
// ════════════════════════════════════════════════════════════════════════════
test.describe("Parcours d'inscription avec choix du plan", () => {
  test.use({ storageState: { cookies: [], origins: [] } });   // visiteur anonyme

  const email = `parcours.${Date.now()}@hisabpro.ma`;
  const motDePasse = "MotDePasse123!";
  const cabinet = `TEST_PARCOURS ${Date.now()}`;
  let userId = "";
  let cabinetId = "";

  test.afterAll(async () => {
    if (userId) await admin().auth.admin.deleteUser(userId).catch(() => {});
    if (cabinetId) await admin().from("cabinets").delete().eq("id", cabinetId);
  });

  test("inscription en 2 étapes, plan Pro, puis connexion", async ({ page }) => {
    test.setTimeout(120_000);

    // L'activation du plan est best-effort côté UI (elle ne bloque pas la
    // connexion) : sans ce relais, un échec resterait muet dans la console.
    page.on("console", (m) => {
      if (m.type() === "warning" || m.type() === "error") console.log(`[navigateur:${m.type()}] ${m.text()}`);
    });
    page.on("response", async (r) => {
      if (r.status() >= 400) console.log(`[HTTP ${r.status()}] ${r.url()} → ${(await r.text().catch(() => "")).slice(0, 200)}`);
    });

    await page.goto("/auth");

    // Le clic doit attendre l'HYDRATATION : avant elle, l'onglet Radix ne réagit
    // pas et le test cliquerait dans le vide. On réessaie jusqu'à ce qu'il prenne.
    const panneau = page.getByRole("tabpanel");
    await expect(async () => {
      await page.getByRole("tab", { name: "Inscription" }).click();
      await expect(panneau.getByText("Nom du cabinet")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    // ── Étape 1 : informations (rien n'est encore créé) ──────────────────────
    const textes = panneau.locator('input:not([type="email"]):not([type="password"])');
    await textes.nth(0).fill("Omar");
    await textes.nth(1).fill("Testeur");
    await textes.nth(2).fill(cabinet);
    await panneau.locator('input[type="email"]').fill(email);
    await panneau.locator('input[type="password"]').fill(motDePasse);

    // Aucun compte ne doit exister à ce stade.
    const { data: avant } = await admin().auth.admin.listUsers();
    expect(avant.users.some((u) => u.email === email), "compte créé trop tôt").toBe(false);

    await page.getByRole("button", { name: /Continuer/ }).click();

    // ── Étape 2 : les 3 plans s'affichent ───────────────────────────────────
    await expect(page.getByText("Choisissez votre offre")).toBeVisible();
    for (const plan of ["Starter", "Pro", "Cabinet"]) {
      await expect(panneau.getByText(plan, { exact: true })).toBeVisible();
    }
    const boutons = page.getByRole("button", { name: "Créer mon compte" });
    await expect(boutons).toHaveCount(3);

    // Plan Pro = 2e carte (ordre starter / pro / cabinet). On INSPECTE la requête
    // d'inscription réellement émise : c'est elle qui doit porter le plan choisi.
    const requete = page.waitForRequest((r) => r.url().includes("/auth/v1/signup") && r.method() === "POST");
    await boutons.nth(1).click();
    const corps = JSON.parse((await requete).postData() ?? "{}");
    expect(corps.email).toBe(email);
    expect(corps.data?.plan_code, "le plan choisi n'est pas transmis à l'inscription").toBe("pro");
    expect(corps.data?.cabinet_nom).toBe(cabinet);

    // ── Le compte ───────────────────────────────────────────────────────────
    // Supabase Auth exige la confirmation d'email et son SMTP intégré est
    // plafonné (~2 mails/h) : l'inscription peut être refusée en `over_email_
    // send_rate_limit`, ce qui est une limite d'INFRA, pas de notre code. Dans ce
    // cas on crée le compte côté admin AVEC LES MÊMES métadonnées (celles que la
    // requête ci-dessus vient de prouver) et on poursuit sur la moitié qui nous
    // appartient : la connexion et l'activation du plan.
    const trouve = async () => (await admin().auth.admin.listUsers()).data.users.find((u) => u.email === email);
    let cree = await trouve();
    if (!cree) {
      const { data: force, error } = await admin().auth.admin.createUser({
        email, password: motDePasse, email_confirm: true, user_metadata: corps.data,
      });
      if (error) throw new Error(`création du compte impossible : ${error.message}`);
      cree = force.user!;
      console.log("[e2e] SMTP Supabase saturé → compte créé via l'admin avec les métadonnées émises par l'UI");
    }
    userId = cree!.id;
    expect((cree!.user_metadata as any).plan_code, "plan non mémorisé sur le compte").toBe("pro");

    // Le trigger a créé le cabinet + l'abonnement d'essai (Starter par défaut).
    const { data: profil } = await admin().from("profiles").select("cabinet_id").eq("id", userId).maybeSingle();
    cabinetId = (profil as any)?.cabinet_id;
    expect(cabinetId, "cabinet non créé à l'inscription").toBeTruthy();

    // Confirmation d'email (l'utilisateur cliquerait le lien reçu).
    await admin().auth.admin.updateUserById(userId, { email_confirm: true });

    // Retour sur l'onglet Connexion (l'UI y renvoie après une inscription réussie).
    await page.goto("/auth");
    await expect(async () => {
      await page.getByRole("tab", { name: "Connexion" }).click();
      await expect(page.getByRole("tabpanel").locator('input[type="email"]')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByRole("tabpanel").locator('input[type="email"]').fill(email);

    // ── Connexion → le plan choisi est activé ───────────────────────────────
    await page.getByRole("tabpanel").locator('input[type="password"]').fill(motDePasse);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.waitForURL("**/dossiers", { timeout: 30_000 });

    const { data: sub } = await admin()
      .from("subscriptions")
      .select("status, plans(code)")
      .eq("cabinet_id", cabinetId)
      .in("status", ["trial", "active", "past_due"])
      .maybeSingle();
    expect((sub as any)?.plans?.code, "plan Pro non activé à la connexion").toBe("pro");
    expect((sub as any)?.status).toBe("active");

    // Le code est consommé : une 2e connexion ne réappliquera pas le plan.
    const { data: apresLogin } = await admin().auth.admin.getUserById(userId);
    expect((apresLogin.user!.user_metadata as any).plan_code ?? null, "plan_code non effacé").toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 2 — Quota : seul un document parti au LLM décompte
// ════════════════════════════════════════════════════════════════════════════
test.describe("Quota de scans", () => {
  test("cache OCR et rejeu ne décomptent pas de scan", async ({ page }) => {
    test.skip(!CONFIG.E2E_EMAIL, "E2E_EMAIL/E2E_PASSWORD absents");
    test.setTimeout(240_000);

    const dossier = await resolveDossier();
    const { data: d } = await admin().from("dossiers").select("cabinet_id").eq("id", dossier.id).maybeSingle();
    const cabinetId = (d as any).cabinet_id as string;

    const numero = `FA-E2E-${Date.now()}`;
    const pdf = facturePdf(numero);
    const pdfVariante = facturePdf(numero, true);   // mêmes données, octets différents

    const scanner = async (buffer: Buffer, nom: string) => {
      await page.getByRole("button", { name: "Nouvelle facture" }).click();
      await page.locator('input[type="file"]').setInputFiles({ name: nom, mimeType: "application/pdf", buffer });
      // L'extraction est terminée quand le formulaire porte le n° de facture.
      await expect(page.locator(`input[value="${numero}"]`)).toBeVisible({ timeout: 120_000 });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
    };

    await page.goto(`/dossiers/${dossier.id}/factures`);
    const depart = await nbScans(cabinetId);

    // 1) Document neuf → appel LLM réel → 1 scan décompté.
    await scanner(pdf, "facture-e2e.pdf");
    expect(await nbScans(cabinetId), "un scan neuf doit décompter").toBe(depart + 1);

    // 2) MÊME fichier → rejeu (même clé d'idempotence) → rien de plus.
    await scanner(pdf, "facture-e2e.pdf");
    expect(await nbScans(cabinetId), "un re-scan ne doit pas décompter").toBe(depart + 1);

    // 3) Fichier DIFFÉRENT au même contenu → scan neuf pour le quota, mais servi
    //    par le cache OCR (aucun appel IA) → le crédit consommé est RENDU.
    await scanner(pdfVariante, "facture-e2e-bis.pdf");
    expect(await nbScans(cabinetId), "un cache-hit doit rendre le scan").toBe(depart + 1);

    // La jauge d'Usage IA reflète le même compteur.
    await page.goto(`/dossiers/${dossier.id}/analytics`);
    await expect(page.getByText("Documents scannés ce mois")).toBeVisible();
    await expect(page.getByText(/scans?$|\/ \d+ scans/)).toBeVisible();

    // Nettoyage : on retire le scan de test et son cache.
    await admin().from("usage_records").delete().eq("cabinet_id", cabinetId)
      .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
    await admin().from("ocr_cache").delete().eq("dossier_id", dossier.id)
      .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
  });
});
