import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/dossiers/$dossierId/")({
  component: () => {
    const { dossierId } = Route.useParams();
    return <Navigate to={`/dossiers/${dossierId}/dashboard`} replace />;
  },
});