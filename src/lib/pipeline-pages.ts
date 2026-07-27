/**
 * pipeline-pages — chevauche le rendu d'une page avec le traitement de la page
 * précédente, SANS jamais paralléliser le traitement lui-même.
 *
 * Cas d'usage : l'OCR d'un relevé multi-pages. Le rendu canvas (CPU, local) et
 * l'appel OCR (réseau, distant) s'exécutaient en série :
 *
 *     rendu(1) ─ ocr(1) ─ rendu(2) ─ ocr(2) ─ rendu(3) ─ ocr(3)
 *
 * alors que le rendu de la page suivante peut se faire pendant que l'appel de la
 * page courante est en vol :
 *
 *     rendu(1) ─ ocr(1) ─── ocr(2) ─── ocr(3)
 *                └ rendu(2) ┘ └ rendu(3) ┘
 *
 * Le traitement reste STRICTEMENT séquentiel et dans l'ordre des pages : c'est
 * indispensable quand une page dépend du résultat de la précédente (report du
 * solde d'un relevé). Seul le rendu, qui ne dépend de rien, est anticipé.
 */

/**
 * @param nbPages  nombre de pages, 1-indexées.
 * @param rendre   produit l'image d'une page (peut être lancé en avance).
 * @param traiter  consomme l'image ; appelé une seule fois par page, en ordre
 *                 croissant, et jamais avant que l'appel précédent soit résolu.
 */
export async function traiterPagesEnPipeline<TImage, TResultat>(
  nbPages: number,
  rendre: (page: number) => Promise<TImage>,
  traiter: (image: TImage, page: number) => Promise<TResultat>,
): Promise<TResultat[]> {
  const resultats: TResultat[] = [];
  if (nbPages <= 0) return resultats;

  let renduCourant = rendre(1);
  for (let page = 1; page <= nbPages; page++) {
    const image = await renduCourant;

    // Lancé AVANT d'attendre le traitement de la page courante : c'est tout le
    // gain. Sans le `catch` inerte, un rendu qui échoue pendant que `traiter`
    // est en vol produirait un « unhandled rejection » ; le rejet reste bien
    // relancé au tour suivant, à l'`await renduCourant`.
    const renduSuivant = page < nbPages ? rendre(page + 1) : null;
    renduSuivant?.catch(() => {});

    try {
      resultats.push(await traiter(image, page));
    } catch (e) {
      // Le rendu anticipé n'a plus de consommateur : son rejet éventuel est déjà
      // neutralisé ci-dessus, on peut propager l'erreur de traitement telle quelle.
      throw e;
    }

    if (renduSuivant) renduCourant = renduSuivant;
  }
  return resultats;
}
