import { connect } from "cloudflare:sockets";
// ============================================================
// 字节工具
// ============================================================
const te = new TextEncoder();
function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
const u16 = (n) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const u24 = (n) => new Uint8Array([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const vec8 = (d) => concat(new Uint8Array([d.length]), d);
const vec16 = (d) => concat(u16(d.length), d);
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
class Reader {
  constructor(data) {
    this.d = data;
    this.p = 0;
  }
  u8() {
    return this.d[this.p++];
  }
  u16() {
    const v = (this.d[this.p] << 8) | this.d[this.p + 1];
    this.p += 2;
    return v;
  }
  u24() {
    const v = (this.d[this.p] << 16) | (this.d[this.p + 1] << 8) | this.d[this.p + 2];
    this.p += 3;
    return v;
  }
  bytes(n) {
    const v = this.d.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
}
// ============================================================
// WebCrypto X25519
// ============================================================
async function genKeyPair() {
  const kp = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]));
  const pub = new Uint8Array(/** @type {ArrayBuffer} */ (await crypto.subtle.exportKey("raw", kp.publicKey)));
  return { priv: kp.privateKey, pub };
}
async function deriveShared(kp, serverPub) {
  const sk = await crypto.subtle.importKey("raw", serverPub, { name: "X25519" }, false, []);
  // @ts-ignore
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: sk }, kp.priv, 256));
}
// ============================================================
// HKDF / TLS 1.3 key schedule
// ============================================================
const EMPTY = new Uint8Array(0);
const ZEROS = new Uint8Array(32);
async function sha256(d) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", d));
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const hkdfExtract = (salt, ikm) => hmac(salt, ikm);
async function hkdfExpand(prk, info, len) {
  const out = new Uint8Array(len);
  let t = EMPTY,
    off = 0,
    counter = 1;
  while (off < len) {
    t = await hmac(prk, concat(t, info, new Uint8Array([counter])));
    const n = Math.min(t.length, len - off);
    out.set(t.subarray(0, n), off);
    off += n;
    counter++;
  }
  return out;
}
function hkdfExpandLabel(prk, label, context, len) {
  const full = te.encode("tls13 " + label);
  const info = concat(u16(len), vec8(full), vec8(context));
  return hkdfExpand(prk, info, len);
}
const importAes = (raw) => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
// ============================================================
// AEAD record 层（cipher 内部自管 seq）
// ============================================================
function buildNonce(iv, seq) {
  const nonce = Uint8Array.from(iv);
  let s = BigInt(seq);
  for (let i = 0; i < 8; i++) {
    nonce[iv.length - 1 - i] ^= Number(s & 0xffn);
    s >>= 8n;
  }
  return nonce;
}
// 由 traffic secret 派生出 {key, iv, seq}，seq 由 seal/open 自动递增
async function makeCipher(secret) {
  const key = await importAes(await hkdfExpandLabel(secret, "key", EMPTY, 16));
  const iv = await hkdfExpandLabel(secret, "iv", EMPTY, 12);
  return { key, iv, seq: 0 };
}
async function seal(cipher, innerType, plaintext) {
  const inner = concat(plaintext, new Uint8Array([innerType]));
  const aad = concat(new Uint8Array([0x17]), u16(0x0303), u16(inner.length + 16));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buildNonce(cipher.iv, cipher.seq++), additionalData: aad, tagLength: 128 }, cipher.key, inner));
  return concat(new Uint8Array([0x17]), u16(0x0303), u16(ct.length), ct);
}
async function open(cipher, fullRecord) {
  const header = fullRecord.subarray(0, 5);
  const body = fullRecord.subarray(5);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buildNonce(cipher.iv, cipher.seq++), additionalData: header, tagLength: 128 }, cipher.key, body));
  // 去掉尾部 0 填充，最后一个非零字节是 inner content type
  let i = pt.length - 1;
  while (i >= 0 && pt[i] === 0) i--;
  return { type: pt[i], content: pt.subarray(0, i) };
}
// ============================================================
// 记录 / 握手消息重组
// ============================================================
class RecordReader {
  constructor(reader) {
    this.r = reader;
    this.buf = EMPTY;
    this.done = false;
  }
  async fill(n) {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.r.read();
      if (done) {
        this.done = true;
        break;
      }
      this.buf = concat(this.buf, value);
    }
  }
  async readRecord() {
    await this.fill(5);
    if (this.buf.length < 5) return null;
    const type = this.buf[0];
    const len = (this.buf[3] << 8) | this.buf[4];
    await this.fill(5 + len);
    if (this.buf.length < 5 + len) return null;
    const full = this.buf.subarray(0, 5 + len);
    this.buf = this.buf.subarray(5 + len);
    return { type, fragment: full.subarray(5), full };
  }
}
class HsReader {
  constructor() {
    this.buf = EMPTY;
  }
  push(d) {
    this.buf = concat(this.buf, d);
  }
  next() {
    if (this.buf.length < 4) return null;
    const len = (this.buf[1] << 16) | (this.buf[2] << 8) | this.buf[3];
    if (this.buf.length < 4 + len) return null;
    const msg = this.buf.subarray(0, 4 + len);
    this.buf = this.buf.subarray(4 + len);
    return msg;
  }
}
// 从（明文 / 加密）记录流里取下一条握手消息；返回 null 表示连接关闭
async function readHandshakeMsg(rr, hsr, cipher) {
  for (;;) {
    const msg = hsr.next();
    if (msg) return msg;
    const rec = await rr.readRecord();
    if (!rec) return null;
    if (rec.type === 0x14) continue; // 跳过 CCS
    if (rec.type === 0x15) throw new Error("明文 alert: " + Array.from(rec.fragment));
    if (rec.type !== 0x17) throw new Error("意外的记录类型 " + rec.type);
    const { type, content } = await open(cipher, rec.full);
    if (type === 0x16) hsr.push(content);
    else if (type === 0x15) throw new Error("加密 alert: " + Array.from(content));
    // 其余 inner 类型忽略
  }
}
// ============================================================
// ClientHello / ServerHello
// ============================================================
const ext = (type, data) => concat(u16(type), vec16(data));
function buildClientHello(sni, random, sessionId, pub) {
  const sniBytes = te.encode(sni);
  const serverName = ext(0x0000, vec16(concat(new Uint8Array([0x00]), vec16(sniBytes))));
  const supportedVers = ext(0x002b, vec8(u16(0x0304)));
  const supportedGroups = ext(0x000a, vec16(u16(0x001d))); // x25519
  const keyShare = ext(0x0033, vec16(concat(u16(0x001d), vec16(pub))));
  const sigSchemes = [0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0601, 0x0403, 0x0503, 0x0603, 0x0807, 0x0808];
  let sigBytes = EMPTY;
  for (const s of sigSchemes) sigBytes = concat(sigBytes, u16(s));
  const sigAlgs = ext(0x000d, vec16(sigBytes));
  const alpn = ext(0x0010, vec16(vec8(te.encode("http/1.1"))));
  const extensions = concat(serverName, supportedVers, supportedGroups, keyShare, sigAlgs, alpn);
  const body = concat(
    u16(0x0303),
    random,
    vec8(sessionId),
    vec16(u16(0x1301)), // cipher_suites = [TLS_AES_128_GCM_SHA256]
    vec8(new Uint8Array([0x00])), // compression = [null]
    vec16(extensions),
  );
  return concat(new Uint8Array([0x01]), u24(body.length), body);
}
const HRR_RANDOM = new Uint8Array([
  0xcf, 0x21, 0xad, 0x74, 0xe5, 0x9a, 0x61, 0x11, 0xbe, 0x1d, 0x8c, 0x02, 0x1e, 0x65, 0xb8, 0x91, 0xc2, 0xa2, 0x11, 0x16, 0x7a, 0xbb, 0x8c, 0x5e, 0x07, 0x9e, 0x09, 0xe2, 0xc8, 0xa8, 0x33, 0x9c,
]);
function parseServerHello(msg) {
  const r = new Reader(msg);
  if (r.u8() !== 2) throw new Error("不是 ServerHello");
  r.u24(); // length
  r.u16(); // legacy_version
  const random = r.bytes(32);
  if (bytesEqual(random, HRR_RANDOM)) throw new Error("收到 HelloRetryRequest（不支持）");
  r.bytes(r.u8()); // session id echo
  const cipher = r.u16();
  r.u8(); // compression
  const extLen = r.u16();
  const end = r.p + extLen;
  let serverPub = null,
    version = 0x0303;
  while (r.p < end) {
    const t = r.u16(),
      data = r.bytes(r.u16());
    if (t === 0x002b) version = (data[0] << 8) | data[1];
    else if (t === 0x0033) {
      const er = new Reader(data);
      er.u16();
      serverPub = er.bytes(er.u16());
    }
  }
  return { cipher, serverPub, version };
}
// ============================================================
// 主流程
// ============================================================
async function miniTlsRequest(host, port, sni) {
  const socket = connect({ hostname: host, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const rr = new RecordReader(reader);
  try {
    // 1) ClientHello
    const kp = await genKeyPair();
    const clientHello = buildClientHello(sni, crypto.getRandomValues(new Uint8Array(32)), crypto.getRandomValues(new Uint8Array(32)), kp.pub);
    await writer.write(concat(new Uint8Array([0x16]), u16(0x0303), u16(clientHello.length), clientHello));
    let transcript = clientHello;
    // 2) ServerHello（明文）
    const shr = new HsReader();
    let serverHelloMsg = null;
    while (!serverHelloMsg) {
      const rec = await rr.readRecord();
      if (!rec) throw new Error("ServerHello 之前连接关闭");
      if (rec.type === 0x15) throw new Error("alert: " + Array.from(rec.fragment));
      if (rec.type !== 0x16) throw new Error("意外的记录类型 " + rec.type);
      shr.push(rec.fragment);
      serverHelloMsg = shr.next();
    }
    const sh = parseServerHello(serverHelloMsg);
    if (sh.cipher !== 0x1301) throw new Error("cipher 不匹配: 0x" + sh.cipher.toString(16));
    if (sh.version !== 0x0304) throw new Error("非 TLS 1.3");
    if (!sh.serverPub || sh.serverPub.length !== 32) throw new Error("缺少 x25519 key_share");
    transcript = concat(transcript, serverHelloMsg);
    // 3) 握手密钥派生
    const shared = await deriveShared(kp, sh.serverPub);
    const emptyHash = await sha256(EMPTY);
    const earlySecret = await hkdfExtract(ZEROS, ZEROS);
    const derived1 = await hkdfExpandLabel(earlySecret, "derived", emptyHash, 32);
    const hsSecret = await hkdfExtract(derived1, shared);
    const thSH = await sha256(transcript);
    const cHs = await hkdfExpandLabel(hsSecret, "c hs traffic", thSH, 32);
    const sHs = await hkdfExpandLabel(hsSecret, "s hs traffic", thSH, 32);
    const sHsCipher = await makeCipher(sHs);
    // 4) 读取服务器加密握手 flight（EE / Cert / CertVerify / Finished）
    const hsr = new HsReader();
    let serverFinished = null;
    for (;;) {
      const msg = await readHandshakeMsg(rr, hsr, sHsCipher);
      if (!msg) throw new Error("握手期间连接关闭");
      if (msg[0] === 20) {
        serverFinished = msg;
        break;
      }
      transcript = concat(transcript, msg);
    }
    // 5) 校验 server Finished（不验证证书，仅校验握手完整性）
    const sFinKey = await hkdfExpandLabel(sHs, "finished", EMPTY, 32);
    const expected = await hmac(sFinKey, await sha256(transcript));
    if (!bytesEqual(expected, serverFinished.subarray(4))) throw new Error("server Finished 校验失败");
    transcript = concat(transcript, serverFinished);
    // 6) 应用密钥派生
    const derived2 = await hkdfExpandLabel(hsSecret, "derived", emptyHash, 32);
    const masterSecret = await hkdfExtract(derived2, ZEROS);
    const thFin = await sha256(transcript);
    const cAp = await hkdfExpandLabel(masterSecret, "c ap traffic", thFin, 32);
    const sAp = await hkdfExpandLabel(masterSecret, "s ap traffic", thFin, 32);
    const cApCipher = await makeCipher(cAp);
    const sApCipher = await makeCipher(sAp);
    // 7) 发 dummy CCS + client Finished（握手密钥）
    const cFinKey = await hkdfExpandLabel(cHs, "finished", EMPTY, 32);
    const cVerify = await hmac(cFinKey, await sha256(transcript));
    const clientFinished = concat(new Uint8Array([20]), u24(cVerify.length), cVerify);
    const cHsCipher = await makeCipher(cHs);
    await writer.write(new Uint8Array([0x14, 0x03, 0x03, 0x00, 0x01, 0x01])); // CCS
    await writer.write(await seal(cHsCipher, 0x16, clientFinished));
    // 8) 发 HTTP/1.1 请求（应用密钥）
    const req = `HEAD / HTTP/1.1\r\n` + `Host: ${sni}\r\n` + `User-Agent: mini-tls\r\n` + `Accept: */*\r\n` + `Accept-Encoding: identity\r\n` + `Connection: close\r\n\r\n`;
    await writer.write(await seal(cApCipher, 0x17, te.encode(req)));
    // 9) 读响应（解密应用数据，跳过 NewSessionTicket 等）
    let resp = EMPTY;
    for (;;) {
      const rec = await rr.readRecord();
      if (!rec) break;
      if (rec.type === 0x14) continue; // CCS
      if (rec.type === 0x15) break; // 明文 alert
      if (rec.type !== 0x17) continue;
      const { type, content } = await open(sApCipher, rec.full);
      if (type === 0x17)
        resp = concat(resp, content); // 应用数据
      else if (type === 0x15) break; // close_notify / 加密 alert
      // type === 0x16（NewSessionTicket/KeyUpdate）忽略，seq 已自动递增
    }
    return new TextDecoder().decode(resp);
  } finally {
    try {
      await writer.close();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
    try {
      await socket.close();
    } catch {}
  }
}
export default {
  async fetch(request, env, ctx) {
    try {
      const out = await miniTlsRequest("api.github.com", 443, "api.github.com");
      return new Response(out || "(empty response)", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (e) {
      return new Response("TLS error: " + ((e && e.stack) || e), {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
};
