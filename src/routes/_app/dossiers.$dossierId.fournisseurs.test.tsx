import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute(
  '/_app/dossiers/$dossierId/fournisseurs/test',
)({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/_app/dossiers/$dossierId/fournisseurs/test"!</div>
}
