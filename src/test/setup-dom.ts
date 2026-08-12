// ============================================================================
// setup-dom.ts — Amorçage commun des tests.
//
// `setupFiles` s'applique à TOUS les fichiers de test, y compris ceux qui
// tournent en environnement Node : tout ce qui touche au DOM est donc gardé par
// la présence de `document`. Sans cette garde, ajouter un test de composant
// ferait échouer les 300 tests de logique pure qui n'ont jamais eu de DOM.
// ============================================================================

import { afterEach, vi } from "vitest";

const aUnDom = typeof document !== "undefined";

if (aUnDom) {
  // Radix (Select, Dialog, Switch) mesure et anime : jsdom n'implémente ni
  // ResizeObserver, ni les API de PointerEvent, ni scrollIntoView. Sans ces
  // bouchons, monter un composant shadcn lève avant même la première assertion.
  class ResizeObserverBouchon {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).ResizeObserver ??= ResizeObserverBouchon;
  (globalThis as any).DOMRect ??= class {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    top = 0; left = 0; right = 0; bottom = 0;
    static fromRect() { return new (globalThis as any).DOMRect(); }
    toJSON() { return {}; }
  };

  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  (Element.prototype as any).hasPointerCapture ??= () => false;
  (Element.prototype as any).setPointerCapture ??= () => {};
  (Element.prototype as any).releasePointerCapture ??= () => {};

  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    })) as any;
  }

  afterEach(async () => {
    // Import dynamique : le paquet n'est chargé que quand un DOM existe.
    const { cleanup } = await import("@testing-library/react");
    cleanup();
    vi.clearAllMocks();
  });
}
