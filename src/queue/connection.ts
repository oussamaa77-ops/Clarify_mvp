// connection.ts — connexion Redis partagée (Queue côté serveur + Worker).
// Si REDIS_URL est absent, `connection` = null → le système bascule en mode
// INLINE (traitement synchrone dans la server fn) pour ne jamais bloquer l'app.
import IORedis from "ioredis";

export const REDIS_URL = process.env.REDIS_URL ?? "";
export const redisEnabled = !!REDIS_URL;

// BullMQ exige maxRetriesPerRequest: null sur la connexion.
export const connection: IORedis | null = redisEnabled
  ? new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false })
  : null;

if (connection) {
  connection.on("error", (e) => console.error("[redis] erreur:", e.message));
}
