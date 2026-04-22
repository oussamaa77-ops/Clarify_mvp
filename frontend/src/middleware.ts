import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Routes publiques — toujours accessibles
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/dossiers/accept")
  ) {
    return NextResponse.next();
  }

  // Page dossiers — accessible sans active_dossier_id
  if (pathname === "/dossiers") {
    return NextResponse.next();
  }

  // Toutes les autres pages — laisser passer
  // (le frontend gère la redirection via localStorage)
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
}