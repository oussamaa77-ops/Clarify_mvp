-- ============================================================================
-- release_scan_quota — rend au quota un scan qui n'a RIEN coûté.
--
-- Le garde-quota (consume_scan_quota) est appelé AVANT l'OCR : il le doit, sinon
-- un scan refusé aurait déjà payé l'IA. Mais à ce moment-là on ignore encore si
-- le document partira vraiment au LLM : il peut être servi par le cache OCR ou
-- par la mémoire des tiers, et ne déclencher AUCUN appel IA.
--
-- Règle produit : un document traité sans appel IA ne consomme pas de scan.
-- On annule donc a posteriori la consommation en supprimant l'enregistrement
-- d'usage — la clé d'idempotence identifie exactement le scan à rendre.
--
-- Idempotent : rendre deux fois le même scan ne rend qu'un crédit (la 2e
-- suppression ne trouve plus rien). SECURITY DEFINER + REVOKE : seul le serveur
-- (service_role) peut rendre un crédit, sinon un client s'offrirait du quota.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_scan_quota(_idempotency_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_supprimes INTEGER;
BEGIN
  DELETE FROM public.usage_records WHERE idempotency_key = _idempotency_key;
  GET DIAGNOSTICS v_supprimes = ROW_COUNT;

  RETURN jsonb_build_object('released', v_supprimes > 0);
END $$;

REVOKE ALL ON FUNCTION public.release_scan_quota(TEXT) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.release_scan_quota(TEXT) IS
  'Annule la consommation d''un scan resté sans appel IA (cache OCR / mémoire des tiers). Serveur uniquement.';
