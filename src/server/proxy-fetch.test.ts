import { describe, it, expect } from "vitest";
import { repliSansVerificationAutorise } from "./proxy-fetch";

describe("repliSansVerificationAutorise", () => {
  it("interdit le repli sans vérification TLS en production", () => {
    expect(repliSansVerificationAutorise({ NODE_ENV: "production" })).toBe(false);
  });

  it("l'autorise hors production (poste de dev derrière le proxy)", () => {
    expect(repliSansVerificationAutorise({ NODE_ENV: "development" })).toBe(true);
    expect(repliSansVerificationAutorise({})).toBe(true);
  });

  it("PROXY_TLS_INSECURE tranche dans les deux sens", () => {
    expect(repliSansVerificationAutorise({ NODE_ENV: "production", PROXY_TLS_INSECURE: "true" })).toBe(true);
    expect(repliSansVerificationAutorise({ NODE_ENV: "development", PROXY_TLS_INSECURE: "false" })).toBe(false);
    expect(repliSansVerificationAutorise({ NODE_ENV: "production", PROXY_TLS_INSECURE: " 1 " })).toBe(true);
  });
});
