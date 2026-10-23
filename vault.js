// Kasa mantığı: parola -> anahtar, klasör anahtarı, yanlış deneme sınırı.
// DOM'a bağlı değildir; saklama katmanı (store) dışarıdan verilir.
//
// Tasarım:
//  - Her klasörün rastgele bir ana anahtarı (MK, 32 bayt) vardır. Dosyalar (Faz 2) bununla korunur.
//  - MK diskte düz durmaz: paroladan türetilen anahtarla (KEK) şifrelenmiş halde saklanır.
//  - Parola değişince yalnızca MK yeniden sarılır; dosyalara dokunulmaz.
//  - Parola doğrulaması ayrıca saklanmaz: MK doğru çözülürse parola doğrudur (AES-GCM etiketi).

export class VaultError extends Error {
  constructor(code, msg, extra) {
    super(msg || code);
    this.code = code;
    Object.assign(this, extra || {});
  }
}

const te = new TextEncoder();
const td = new TextDecoder();
const ALG = 'AES-GCM';
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const aad = (id, part) => te.encode('gizli:v1:' + id + ':' + part);

export function createVault(store, opts = {}) {
  const ITER = opts.iterations || 2000000;
  const now = opts.now || (() => Date.now());
  const FREE_TRIES = 5;

  function checkId(id) {
    if (!Number.isInteger(id) || id < 1) throw new VaultError('badid', 'Geçersiz klasör.');
  }

  async function kekFrom(password, salt, iter) {
    const km = await crypto.subtle.importKey('raw', te.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      km, { name: ALG, length: 256 }, false, ['encrypt', 'decrypt']);
  }

  const mkFromRaw = raw => crypto.subtle.importKey('raw', raw, ALG, false, ['encrypt', 'decrypt']);

  async function sealName(key, id, name) {
    const iv = rnd(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: ALG, iv, additionalData: aad(id, 'name') }, key, te.encode(JSON.stringify({ name }))));
    return { nameIv: iv, nameCt: ct };
  }

  async function openName(key, id, rec) {
    const pt = await crypto.subtle.decrypt(
      { name: ALG, iv: rec.nameIv, additionalData: aad(id, 'name') }, key, rec.nameCt);
    return JSON.parse(td.decode(pt)).name;
  }

  async function openRaw(rec, id, password) {
    const kek = await kekFrom(password, rec.salt, rec.iter);
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: ALG, iv: rec.wrapIv, additionalData: aad(id, 'mk') }, kek, rec.wrapped));
  }

  function checkLock(rec) {
    if (rec.lockUntil && rec.lockUntil > now()) {
      throw new VaultError('locked', 'Çok fazla yanlış deneme.', { until: rec.lockUntil });
    }
  }

  async function registerFail(rec) {
    rec.fails = (rec.fails || 0) + 1;
    if (rec.fails >= FREE_TRIES) {
      const step = rec.fails - FREE_TRIES;
      rec.lockUntil = now() + Math.min(30000 * Math.pow(2, step), 3600000);
    }
    await store.put(rec);
    throw new VaultError('badpass', 'Yanlış parola.', { fails: rec.fails, until: rec.lockUntil || 0 });
  }

  async function setup(id, name, password) {
    checkId(id);
    if (await store.get(id)) throw new VaultError('exists', 'Bu klasör zaten kurulu.');
    const salt = rnd(16);
    const kek = await kekFrom(password, salt, ITER);
    const raw = rnd(32);
    const wrapIv = rnd(12);
    const wrapped = new Uint8Array(await crypto.subtle.encrypt(
      { name: ALG, iv: wrapIv, additionalData: aad(id, 'mk') }, kek, raw));
    const key = await mkFromRaw(raw);
    raw.fill(0);
    const sn = await sealName(key, id, name);
    await store.put({
      id, v: 1, salt, iter: ITER, wrapIv, wrapped,
      nameIv: sn.nameIv, nameCt: sn.nameCt,
      created: now(), fails: 0, lockUntil: 0
    });
    return { id, key, name };
  }

  async function unlock(id, password) {
    checkId(id);
    const rec = await store.get(id);
    if (!rec) throw new VaultError('empty', 'Bu klasör henüz kurulmadı.');
    checkLock(rec);
    let raw;
    try {
      raw = await openRaw(rec, id, password);
    } catch (e) {
      return registerFail(rec);
    }
    const key = await mkFromRaw(raw);
    raw.fill(0);
    const name = await openName(key, id, rec);
    if (rec.fails || rec.lockUntil) {
      rec.fails = 0;
      rec.lockUntil = 0;
      await store.put(rec);
    }
    return { id, key, name };
  }

  async function rename(session, newName) {
    const rec = await store.get(session.id);
    if (!rec) throw new VaultError('empty', 'Klasör bulunamadı.');
    const sn = await sealName(session.key, session.id, newName);
    rec.nameIv = sn.nameIv;
    rec.nameCt = sn.nameCt;
    await store.put(rec);
    session.name = newName;
  }

  async function changePassword(id, oldPassword, newPassword) {
    checkId(id);
    const rec = await store.get(id);
    if (!rec) throw new VaultError('empty', 'Klasör bulunamadı.');
    checkLock(rec);
    let raw;
    try {
      raw = await openRaw(rec, id, oldPassword);
    } catch (e) {
      return registerFail(rec);
    }
    const salt = rnd(16);
    const kek = await kekFrom(newPassword, salt, ITER);
    const wrapIv = rnd(12);
    const wrapped = new Uint8Array(await crypto.subtle.encrypt(
      { name: ALG, iv: wrapIv, additionalData: aad(id, 'mk') }, kek, raw));
    raw.fill(0);
    rec.salt = salt;
    rec.iter = ITER;
    rec.wrapIv = wrapIv;
    rec.wrapped = wrapped;
    rec.fails = 0;
    rec.lockUntil = 0;
    await store.put(rec);
  }

  // Klasörü parolasız sıfırlar: anahtar kaydı silinir, içerik bir daha çözülemez.
  // Faz 2'de burada klasörün şifreli dosyaları da silinecek.
  async function reset(id) {
    checkId(id);
    // Önce dosyalar silinir: bu adım başarısız olursa klasör kaydı korunur ve yeniden denenebilir.
    if (opts.onReset) await opts.onReset(id);
    await store.delete(id);
  }

  // Klasörü parolasını doğrulayarak siler (yanlış parola sayaca işler).
  async function remove(id, password) {
    checkId(id);
    const rec = await store.get(id);
    if (!rec) throw new VaultError('empty', 'Klasör bulunamadı.');
    checkLock(rec);
    try {
      (await openRaw(rec, id, password)).fill(0);
    } catch (e) {
      return registerFail(rec);
    }
    await reset(id);
  }

  // Kurulu klasörler (eskiden yeniye).
  async function slots() {
    const recs = (await store.all()).slice().sort((a, b) => (a.created || 0) - (b.created || 0) || a.id - b.id);
    return recs.map(r => ({ id: r.id, exists: true, lockUntil: r.lockUntil || 0 }));
  }

  // Yeni klasör için boş numara.
  async function nextId() {
    const recs = await store.all();
    return recs.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  }

  return { setup, unlock, rename, changePassword, reset, remove, slots, nextId };
}
