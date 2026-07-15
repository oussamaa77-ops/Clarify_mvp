-- Logging structuré & persistant de l'usage IA / mémoire (mesure du skipLLM).
--
-- Une ligne PAR traitement (une facture, ou une transaction de relevé) :
--   • method       : 'llm' | 'memoire' | 'regex' — d'où vient la classification ;
--   • skip_llm     : true si l'appel IA a été ÉVITÉ grâce à la mémoire ;
--   • sens         : 'facture' | 'banque' — quel pipeline ;
--   • cout_estime  : coût IA estimé (USD) de l'appel — ÉCONOMISÉ si skip_llm=true,
--                    DÉPENSÉ sinon ;
--   • created_at   : horodatage (agrégation par jour).
-- Insert best-effort côté serveur (service_role) — ne bloque jamais le scan.

CREATE TABLE IF NOT EXISTS public.analytics_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id   UUID REFERENCES public.dossiers(id) ON DELETE CASCADE,
  sens         TEXT NOT NULL,                          -- 'facture' | 'banque'
  method       TEXT NOT NULL,                          -- 'llm' | 'memoire' | 'regex'
  skip_llm     BOOLEAN NOT NULL DEFAULT false,
  cout_estime  NUMERIC NOT NULL DEFAULT 0,             -- USD estimé de l'appel IA
  libelle      TEXT,                                    -- contexte court (optionnel)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_usage_dossier_date
  ON public.analytics_usage (dossier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_usage_date
  ON public.analytics_usage (created_at DESC);

ALTER TABLE public.analytics_usage ENABLE ROW LEVEL SECURITY;

-- Lecture réservée aux membres du dossier (les lignes globales dossier_id IS NULL
-- restent visibles pour permettre un tableau de bord transverse au cabinet).
CREATE POLICY "au_select" ON public.analytics_usage FOR SELECT TO authenticated
  USING (dossier_id IS NULL OR public.has_dossier_access(auth.uid(), dossier_id));
CREATE POLICY "au_insert" ON public.analytics_usage FOR INSERT TO authenticated
  WITH CHECK (dossier_id IS NULL OR public.has_dossier_access(auth.uid(), dossier_id));

COMMENT ON TABLE public.analytics_usage IS
  'Journal d''usage IA/mémoire : mesure du taux de skipLLM et du coût IA économisé.';
