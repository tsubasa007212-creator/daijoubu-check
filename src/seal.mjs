// 台帳に署名を付ける。保存先を持たずに、画面から戻った台帳が書き換えられていないと確かめる。
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET = process.env.STATE_SECRET || randomBytes(32).toString("hex");

export function seal(state) {
  return createHmac("sha256", SECRET).update(JSON.stringify(state)).digest("hex");
}

export function isSealed(state, signature) {
  if (typeof signature !== "string") return false;
  const expected = Buffer.from(seal(state));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
