/** Géométrie partagée des marques de graphique. */

/**
 * Rectangle horizontal dont seules les extrémités DROITES sont arrondies : l'extrémité
 * de donnée porte le rayon, le pied reste carré sur la ligne de base.
 * `r` est borné par la largeur et la demi-hauteur pour qu'un segment étroit ne se déforme pas.
 */
export function cheminSegment(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w, h / 2));
  if (rr === 0) return `M${x},${y} h${w} v${h} h${-w} Z`;
  return `M${x},${y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - 2 * rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(w - rr)} Z`;
}
