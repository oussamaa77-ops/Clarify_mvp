import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * La section « Factures » a été fusionnée dans « Clients », qui regroupe
 * désormais factures, annuaire, documents associés, balance âgée et reporting
 * — comme le fait déjà la section Fournisseurs.
 *
 * La route est conservée en redirection : les liens et favoris existants vers
 * /factures continuent de fonctionner et atterrissent sur le bon onglet.
 */
export const Route = createFileRoute("/_app/dossiers/$dossierId/factures")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/dossiers/$dossierId/clients",
      params: { dossierId: params.dossierId },
      search: { vue: "factures" },
    });
  },
});
