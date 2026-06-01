const URL_RE = /https?:\/\/[^\s"'<>`{}|\\^\[\]]+/gi;
const MAX_CARRY = 8192;
const MAX_URL_LEN = 4096;
const MAX_TEXT_CHARS = 1 << 30;
const HEARTBEAT_CHARS = 2 << 20;
const MAX_GZIP_MEMBERS = 1 << 20;
const EMPTY_U8 = new Uint8Array(0);
const FAST_BITS = 16;
const FAST_SIZE = 1 << FAST_BITS;
const FAST_MASK = FAST_SIZE - 1;
const DECODE_BATCH_BYTES = 16 * 1024;
const CL_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
const LEN_EXTRA = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DIST_EXTRA = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
let FIXED_LITLEN_TREE = null;
let FIXED_DIST_TREE = null;
const DELIM_TABLE = (() => {
  const t = new Uint8Array(128);
  t[0x20] = 1;
  t[0x09] = 1;
  t[0x0a] = 1;
  t[0x0d] = 1;
  t[0x0c] = 1;
  t[0x0b] = 1;
  t[0x22] = 1;
  t[0x27] = 1;
  t[0x3c] = 1;
  t[0x3e] = 1;
  t[0x60] = 1;
  t[0x7b] = 1;
  t[0x7d] = 1;
  t[0x7c] = 1;
  t[0x5c] = 1;
  t[0x5e] = 1;
  t[0x5b] = 1;
  t[0x5d] = 1;
  return t;
})();
function isDelim(c) {
  return c < 128 && DELIM_TABLE[c] === 1;
}
function joinStrings(parts) {
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0] : parts.join("");
}
function buildTailString(chunks, totalLen) {
  let need = totalLen > MAX_CARRY ? MAX_CARRY : totalLen;
  if (need <= 0) return "";
  const parts = [];
  for (let i = chunks.length - 1; i >= 0 && need > 0; i--) {
    const chunk = chunks[i];
    const len = chunk.length;
    if (len <= need) {
      parts.push(chunk);
      need -= len;
    } else {
      parts.push(chunk.slice(len - need));
      need = 0;
    }
  }
  if (parts.length <= 1) {
    return parts.length ? parts[0] : "";
  }
  parts.reverse();
  return parts.join("");
}
function findCutPoint(chunks, totalLen) {
  if (totalLen <= 0) return 0;
  const tail = buildTailString(chunks, totalLen);
  const base = totalLen - tail.length;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (isDelim(tail.charCodeAt(i))) return base + i + 1;
  }
  return totalLen > MAX_CARRY ? totalLen - MAX_CARRY : 0;
}
function splitChunksAt(chunks, cut) {
  if (cut <= 0) {
    return { head: "", tail: joinStrings(chunks) };
  }
  let remaining = cut;
  const headParts = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const len = chunk.length;
    if (remaining >= len) {
      headParts.push(chunk);
      remaining -= len;
      continue;
    }
    if (remaining > 0) {
      headParts.push(chunk.slice(0, remaining));
    }
    let tail = remaining > 0 ? chunk.slice(remaining) : chunk;
    if (i + 1 < chunks.length) {
      tail += joinStrings(chunks.slice(i + 1));
    }
    return {
      head: joinStrings(headParts),
      tail,
    };
  }
  return {
    head: joinStrings(headParts),
    tail: "",
  };
}
function cleanUrl(u) {
  return u.replace(/[,.;:!?]+$/g, "");
}
function extractUrls(text) {
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(URL_RE)) {
    let u = m[0];
    if (u.length > MAX_URL_LEN) continue;
    u = cleanUrl(u);
    if (u.length < 11) continue;
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
function asUint8Array(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError("Expected Uint8Array chunk");
}
function reverseBits(code, len) {
  let rev = 0;
  while (len-- > 0) {
    rev = (rev << 1) | (code & 1);
    code >>>= 1;
  }
  return rev;
}
function buildHuffmanTree(lengths, name = "Huffman tree") {
  let maxLen = 0;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i] | 0;
    if (len < 0 || len > 15) {
      throw new Error(`Invalid ${name}: invalid code length`);
    }
    if (len > maxLen) maxLen = len;
  }
  if (maxLen === 0) {
    const left = new Int32Array(1);
    const right = new Int32Array(1);
    const sym = new Int32Array(1);
    left[0] = -1;
    right[0] = -1;
    sym[0] = -1;
    return { left, right, sym, maxLen, fastTable: null };
  }
  const blCount = new Uint16Array(maxLen + 1);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i] | 0;
    if (len) blCount[len]++;
  }
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    if (code + blCount[bits] > 1 << bits) {
      throw new Error(`Invalid ${name}: oversubscribed`);
    }
    nextCode[bits] = code;
  }
  const codeCursor = new Uint32Array(nextCode);
  const left = [-1];
  const right = [-1];
  const sym = [-1];
  const fastTable = new Uint32Array(FAST_SIZE);
  function newNode() {
    const idx = left.length;
    left.push(-1);
    right.push(-1);
    sym.push(-1);
    return idx;
  }
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const len = lengths[symbol] | 0;
    if (!len) continue;
    const c = codeCursor[len]++;
    const rev = reverseBits(c, len);
    const entry = (symbol << 4) | len;
    const step = 1 << len;
    const count = 1 << (FAST_BITS - len);
    for (let i = 0, idx = rev; i < count; i++, idx += step) {
      fastTable[idx] = entry;
    }
    let node = 0;
    for (let i = len - 1; i >= 0; i--) {
      if (sym[node] !== -1) {
        throw new Error(`Invalid ${name}: prefix conflict`);
      }
      const bit = (c >>> i) & 1;
      let child = bit ? right[node] : left[node];
      if (child === -1) {
        child = newNode();
        if (bit) {
          right[node] = child;
        } else {
          left[node] = child;
        }
      }
      node = child;
    }
    if (sym[node] !== -1 || left[node] !== -1 || right[node] !== -1) {
      throw new Error(`Invalid ${name}: duplicate code`);
    }
    sym[node] = symbol;
  }
  return {
    left: new Int32Array(left),
    right: new Int32Array(right),
    sym: new Int32Array(sym),
    maxLen,
    fastTable,
  };
}
function getFixedTrees() {
  if (FIXED_LITLEN_TREE && FIXED_DIST_TREE) {
    return { litlen: FIXED_LITLEN_TREE, dist: FIXED_DIST_TREE };
  }
  const litLens = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) litLens[i] = 8;
  for (let i = 144; i <= 255; i++) litLens[i] = 9;
  for (let i = 256; i <= 279; i++) litLens[i] = 7;
  for (let i = 280; i <= 287; i++) litLens[i] = 8;
  const distLens = new Uint8Array(32);
  distLens.fill(5);
  FIXED_LITLEN_TREE = buildHuffmanTree(litLens, "fixed literal/length Huffman tree");
  FIXED_DIST_TREE = buildHuffmanTree(distLens, "fixed distance Huffman tree");
  return { litlen: FIXED_LITLEN_TREE, dist: FIXED_DIST_TREE };
}
class GzipMemberScanner {
  constructor() {
    this.buffer = EMPTY_U8;
    this._resetParser();
  }
  _resetParser() {
    this.pos = 0;
    this.bitbuf = 0;
    this.bitlen = 0;
    this.state = "GZIP_HEADER";
    this.gzStage = 0;
    this.gzFlags = 0;
    this.gzExtraRemaining = 0;
    this.lastBlock = false;
    this.litlenTree = null;
    this.distTree = null;
    this.dynStage = 0;
    this.hlit = 0;
    this.hdist = 0;
    this.hclen = 0;
    this.dynCLens = null;
    this.dynCLIndex = 0;
    this.dynCodeLenTree = null;
    this.dynLengths = null;
    this.dynIndex = 0;
    this.dynPendingRepeat = null;
    this.lengthExtra = 0;
    this.distExtra = 0;
    this.storedRemaining = 0;
    this.memberDone = false;
  }
  append(chunk) {
    chunk = asUint8Array(chunk);
    if (!chunk.length) return;
    if (!this.buffer.length) {
      this.buffer = chunk;
      return;
    }
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }
  stripLeadingZeroPadding() {
    let i = 0;
    const buf = this.buffer;
    const len = buf.length;
    if (len >= 4 && (buf.byteOffset & 3) === 0) {
      const u32 = new Uint32Array(buf.buffer, buf.byteOffset, len >>> 2);
      while (i + 4 <= len && u32[i >>> 2] === 0) {
        i += 4;
      }
    } else {
      while (i + 4 <= len && (buf[i] | buf[i + 1] | buf[i + 2] | buf[i + 3]) === 0) {
        i += 4;
      }
    }
    while (i < len && buf[i] === 0) i++;
    if (i > 0) {
      this.takePrefix(i);
    }
  }
  committedBytes() {
    const bufferedBytes = this.bitlen >>> 3;
    return this.pos >= bufferedBytes ? this.pos - bufferedBytes : 0;
  }
  takePrefix(n) {
    if (n <= 0) return EMPTY_U8;
    const out = this.buffer.subarray(0, n);
    this.buffer = n >= this.buffer.length ? EMPTY_U8 : this.buffer.subarray(n);
    this.pos -= n;
    if (this.pos < 0) this.pos = 0;
    return out;
  }
  takeCommittedPrefix() {
    return this.takePrefix(this.committedBytes());
  }
  beginNextMember() {
    this._resetParser();
  }
  scan() {
    while (!this.memberDone) {
      switch (this.state) {
        case "GZIP_HEADER":
          if (!this._parseGzipHeader()) return false;
          break;
        case "BLOCK_HEADER":
          if (!this._parseBlockHeader()) return false;
          break;
        case "STORED_LEN":
          if (!this._parseStoredLen()) return false;
          break;
        case "STORED_SKIP":
          if (!this._parseStoredSkip()) return false;
          break;
        case "DYNAMIC":
          if (!this._parseDynamic()) return false;
          break;
        case "HUFFMAN":
          if (!this._parseHuffman()) return false;
          break;
        case "LEN_EXTRA":
          if (!this._parseLengthExtra()) return false;
          break;
        case "DIST":
          if (!this._parseDistance()) return false;
          break;
        case "DIST_EXTRA":
          if (!this._parseDistanceExtra()) return false;
          break;
        case "FOOTER":
          if (!this._parseFooter()) return false;
          break;
        case "DONE":
          this.memberDone = true;
          return true;
        default:
          throw new Error(`Invalid gzip scanner state: ${this.state}`);
      }
    }
    return true;
  }
  _readBits(n) {
    if (n === 0) return 0;
    let bitbuf = this.bitbuf;
    let bitlen = this.bitlen;
    let pos = this.pos;
    const input = this.buffer;
    while (bitlen < n) {
      if (pos >= input.length) {
        this.pos = pos;
        this.bitbuf = bitbuf;
        this.bitlen = bitlen;
        return null;
      }
      bitbuf |= input[pos++] << bitlen;
      bitlen += 8;
    }
    const val = bitbuf & ((1 << n) - 1);
    this.pos = pos;
    this.bitbuf = bitbuf >>> n;
    this.bitlen = bitlen - n;
    return val;
  }
  _alignToByte() {
    this.pos -= this.bitlen >>> 3;
    this.bitbuf = 0;
    this.bitlen = 0;
  }
  _decodeSymbol(tree) {
    if (!tree || tree.maxLen <= 0) {
      throw new Error("Invalid Huffman code");
    }
    let bitbuf = this.bitbuf;
    let bitlen = this.bitlen;
    let pos = this.pos;
    const input = this.buffer;
    const fastTable = tree.fastTable;
    while (bitlen < FAST_BITS && pos < input.length) {
      bitbuf |= input[pos++] << bitlen;
      bitlen += 8;
    }
    if (fastTable && bitlen >= FAST_BITS) {
      const entry = fastTable[bitbuf & FAST_MASK];
      if (entry !== 0) {
        const len = entry & 15;
        this.pos = pos;
        this.bitbuf = bitbuf >>> len;
        this.bitlen = bitlen - len;
        return entry >>> 4;
      }
    }
    let node = 0;
    const left = tree.left;
    const right = tree.right;
    const sym = tree.sym;
    const maxLen = tree.maxLen;
    for (let depth = 0; depth < maxLen; depth++) {
      if (bitlen === 0) {
        if (pos >= input.length) return null;
        bitbuf = input[pos++];
        bitlen = 8;
      }
      const bit = bitbuf & 1;
      bitbuf >>>= 1;
      bitlen--;
      node = bit ? right[node] : left[node];
      if (node < 0) {
        throw new Error("Invalid Huffman code");
      }
      const s = sym[node];
      if (s >= 0) {
        this.pos = pos;
        this.bitbuf = bitbuf;
        this.bitlen = bitlen;
        return s;
      }
    }
    throw new Error("Invalid Huffman code");
  }
  _parseGzipHeader() {
    for (;;) {
      switch (this.gzStage) {
        case 0: {
          if (this.bitlen !== 0) {
            throw new Error("Invalid gzip header alignment");
          }
          if (this.pos + 10 > this.buffer.length) return false;
          const p = this.pos;
          const b = this.buffer;
          if (b[p] !== 0x1f || b[p + 1] !== 0x8b) {
            throw new Error("Invalid gzip header");
          }
          if (b[p + 2] !== 8) {
            throw new Error("Unsupported gzip compression method");
          }
          const flg = b[p + 3];
          if (flg & 0xe0) {
            throw new Error("Invalid gzip flags");
          }
          this.gzFlags = flg;
          this.pos += 10;
          this.gzStage = 1;
          continue;
        }
        case 1: {
          if (this.gzFlags & 0x04) {
            if (this.pos + 2 > this.buffer.length) return false;
            this.gzExtraRemaining = this.buffer[this.pos] | (this.buffer[this.pos + 1] << 8);
            this.pos += 2;
            this.gzStage = 2;
          } else {
            this.gzStage = 3;
          }
          continue;
        }
        case 2: {
          if (this.gzExtraRemaining > 0) {
            const n = Math.min(this.gzExtraRemaining, this.buffer.length - this.pos);
            this.pos += n;
            this.gzExtraRemaining -= n;
            if (this.gzExtraRemaining > 0) return false;
          }
          this.gzStage = 3;
          continue;
        }
        case 3: {
          if (this.gzFlags & 0x08) {
            while (this.pos < this.buffer.length) {
              if (this.buffer[this.pos++] === 0) {
                this.gzStage = 4;
                break;
              }
            }
            if (this.gzStage !== 4) return false;
          } else {
            this.gzStage = 4;
          }
          continue;
        }
        case 4: {
          if (this.gzFlags & 0x10) {
            while (this.pos < this.buffer.length) {
              if (this.buffer[this.pos++] === 0) {
                this.gzStage = 5;
                break;
              }
            }
            if (this.gzStage !== 5) return false;
          } else {
            this.gzStage = 5;
          }
          continue;
        }
        case 5: {
          if (this.gzFlags & 0x02) {
            if (this.pos + 2 > this.buffer.length) return false;
            this.pos += 2;
          }
          this.gzStage = 0;
          this.state = "BLOCK_HEADER";
          return true;
        }
        default:
          throw new Error("Invalid gzip header state");
      }
    }
  }
  _parseBlockHeader() {
    const bits = this._readBits(3);
    if (bits === null) return false;
    this.lastBlock = (bits & 1) === 1;
    const type = bits >>> 1;
    if (type === 0) {
      this._alignToByte();
      this.state = "STORED_LEN";
      return true;
    }
    if (type === 1) {
      const fixed = getFixedTrees();
      this.litlenTree = fixed.litlen;
      this.distTree = fixed.dist;
      this.state = "HUFFMAN";
      return true;
    }
    if (type === 2) {
      this._initDynamic();
      this.state = "DYNAMIC";
      return true;
    }
    throw new Error("Invalid deflate block type");
  }
  _parseStoredLen() {
    this._alignToByte();
    if (this.pos + 4 > this.buffer.length) return false;
    const len = this.buffer[this.pos] | (this.buffer[this.pos + 1] << 8);
    const nlen = this.buffer[this.pos + 2] | (this.buffer[this.pos + 3] << 8);
    this.pos += 4;
    if (((len ^ 0xffff) & 0xffff) !== nlen) {
      throw new Error("Invalid stored deflate block length");
    }
    this.storedRemaining = len;
    if (this.storedRemaining === 0) {
      this._endBlock();
    } else {
      this.state = "STORED_SKIP";
    }
    return true;
  }
  _parseStoredSkip() {
    if (this.storedRemaining === 0) {
      this._endBlock();
      return true;
    }
    const avail = this.buffer.length - this.pos;
    if (avail <= 0) return false;
    const n = Math.min(avail, this.storedRemaining);
    this.pos += n;
    this.storedRemaining -= n;
    if (this.storedRemaining > 0) return false;
    this._endBlock();
    return true;
  }
  _initDynamic() {
    this.dynStage = 0;
    this.hlit = 0;
    this.hdist = 0;
    this.hclen = 0;
    this.dynCLens = null;
    this.dynCLIndex = 0;
    this.dynCodeLenTree = null;
    this.dynLengths = null;
    this.dynIndex = 0;
    this.dynPendingRepeat = null;
  }
  _parseDynamic() {
    for (;;) {
      switch (this.dynStage) {
        case 0: {
          const v = this._readBits(5);
          if (v === null) return false;
          this.hlit = v + 257;
          this.dynStage = 1;
          continue;
        }
        case 1: {
          const v = this._readBits(5);
          if (v === null) return false;
          this.hdist = v + 1;
          this.dynStage = 2;
          continue;
        }
        case 2: {
          const v = this._readBits(4);
          if (v === null) return false;
          this.hclen = v + 4;
          this.dynCLens = new Uint8Array(19);
          this.dynCLIndex = 0;
          this.dynStage = 3;
          continue;
        }
        case 3: {
          while (this.dynCLIndex < this.hclen) {
            const v = this._readBits(3);
            if (v === null) return false;
            this.dynCLens[CL_ORDER[this.dynCLIndex++]] = v;
          }
          this.dynCodeLenTree = buildHuffmanTree(this.dynCLens, "code length Huffman tree");
          this.dynLengths = new Uint8Array(this.hlit + this.hdist);
          this.dynIndex = 0;
          this.dynPendingRepeat = null;
          this.dynStage = 4;
          continue;
        }
        case 4: {
          while (this.dynIndex < this.dynLengths.length) {
            if (this.dynPendingRepeat) {
              const repeat = this.dynPendingRepeat;
              const extra = this._readBits(repeat.extra);
              if (extra === null) return false;
              const count = repeat.base + extra;
              if (this.dynIndex + count > this.dynLengths.length) {
                throw new Error("Invalid dynamic Huffman repeat");
              }
              this.dynLengths.fill(repeat.value, this.dynIndex, this.dynIndex + count);
              this.dynIndex += count;
              this.dynPendingRepeat = null;
              continue;
            }
            const sym = this._decodeSymbol(this.dynCodeLenTree);
            if (sym === null) return false;
            if (sym < 16) {
              this.dynLengths[this.dynIndex++] = sym;
              continue;
            }
            if (sym === 16) {
              if (this.dynIndex === 0) throw new Error("Invalid dynamic Huffman repeat");
              this.dynPendingRepeat = {
                extra: 2,
                base: 3,
                value: this.dynLengths[this.dynIndex - 1],
              };
              continue;
            }
            if (sym === 17) {
              this.dynPendingRepeat = { extra: 3, base: 3, value: 0 };
              continue;
            }
            if (sym === 18) {
              this.dynPendingRepeat = { extra: 7, base: 11, value: 0 };
              continue;
            }
            throw new Error("Invalid code length symbol");
          }
          const litLens = this.dynLengths.subarray(0, this.hlit);
          const distLens = this.dynLengths.subarray(this.hlit);
          if (!litLens[256]) {
            throw new Error("Missing end-of-block code");
          }
          this.litlenTree = buildHuffmanTree(litLens, "literal/length Huffman tree");
          this.distTree = buildHuffmanTree(distLens, "distance Huffman tree");
          this._initDynamic();
          this.state = "HUFFMAN";
          return true;
        }
        default:
          throw new Error("Invalid dynamic Huffman state");
      }
    }
  }
  _parseHuffman() {
    for (;;) {
      const sym = this._decodeSymbol(this.litlenTree);
      if (sym === null) return false;
      if (sym < 256) {
        continue;
      }
      if (sym === 256) {
        this._endBlock();
        return true;
      }
      if (sym > 285) {
        throw new Error("Invalid literal/length code");
      }
      this.lengthExtra = LEN_EXTRA[sym - 257];
      if (this.lengthExtra) {
        this.state = "LEN_EXTRA";
      } else {
        this.state = "DIST";
      }
      return true;
    }
  }
  _parseLengthExtra() {
    const extra = this._readBits(this.lengthExtra);
    if (extra === null) return false;
    this.state = "DIST";
    return true;
  }
  _parseDistance() {
    const sym = this._decodeSymbol(this.distTree);
    if (sym === null) return false;
    if (sym > 29) {
      throw new Error("Invalid distance code");
    }
    this.distExtra = DIST_EXTRA[sym];
    if (this.distExtra) {
      this.state = "DIST_EXTRA";
    } else {
      this.state = "HUFFMAN";
    }
    return true;
  }
  _parseDistanceExtra() {
    const extra = this._readBits(this.distExtra);
    if (extra === null) return false;
    this.state = "HUFFMAN";
    return true;
  }
  _endBlock() {
    if (this.lastBlock) {
      this._alignToByte();
      this.state = "FOOTER";
    } else {
      this.state = "BLOCK_HEADER";
    }
  }
  _parseFooter() {
    if (this.pos + 8 > this.buffer.length) return false;
    this.pos += 8;
    this.state = "DONE";
    this.memberDone = true;
    return true;
  }
}
function createMemberGunzipPump(controller) {
  const compressed = new TransformStream();
  const writer = compressed.writable.getWriter();
  const reader = compressed.readable.pipeThrough(new DecompressionStream("gzip")).getReader();
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          controller.enqueue(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  })();
  return { writer, pump };
}
function createMultiMemberGunzipStream(options = {}) {
  const { maxMembers = MAX_GZIP_MEMBERS, ignoreZeroPadding = true, onMemberStart, onMemberEnd } = options;
  const scanner = new GzipMemberScanner();
  let current = null;
  let memberNo = 0;
  let completedMembers = 0;
  function startMember(controller) {
    memberNo++;
    if (memberNo > maxMembers) {
      throw new Error(`Too many gzip members: more than ${maxMembers}`);
    }
    if (onMemberStart) onMemberStart(memberNo);
    current = createMemberGunzipPump(controller);
  }
  async function writeChunk(writer, chunk) {
    if (chunk && chunk.length) {
      await writer.write(chunk);
    }
  }
  async function finishMember() {
    const { writer, pump } = current;
    current = null;
    await writer.close();
    await pump;
    completedMembers++;
    if (onMemberEnd) onMemberEnd(completedMembers, memberNo);
    scanner.beginNextMember();
  }
  async function process(controller) {
    for (;;) {
      if (!current) {
        if (ignoreZeroPadding) {
          scanner.stripLeadingZeroPadding();
        }
        if (!scanner.buffer.length) {
          return;
        }
        startMember(controller);
      }
      scanner.scan();
      const safe = scanner.takeCommittedPrefix();
      await writeChunk(current.writer, safe);
      if (scanner.memberDone) {
        await finishMember();
        continue;
      }
      return;
    }
  }
  return new TransformStream({
    async transform(chunk, controller) {
      scanner.append(chunk);
      try {
        await process(controller);
      } catch (e) {
        if (current) {
          try {
            await current.writer.abort(e);
          } catch {}
        }
        throw e;
      }
    },
    async flush(controller) {
      try {
        await process(controller);
        if (current) {
          throw new Error(`Unexpected EOF in gzip member #${memberNo}`);
        }
        if (ignoreZeroPadding) {
          scanner.stripLeadingZeroPadding();
        }
        if (scanner.buffer.length) {
          throw new Error("Trailing non-gzip data after last member");
        }
      } catch (e) {
        if (current) {
          try {
            await current.writer.abort(e);
          } catch {}
        }
        throw e;
      }
    },
  });
}
function concatUint8Chunks(chunks, totalLen) {
  if (totalLen === 0) return EMPTY_U8;
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }
    const { searchParams } = new URL(request.url);
    const target = searchParams.get("url");
    if (!target) {
      return jsonError("URL is required", 400);
    }
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return jsonError("Invalid URL", 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return jsonError("Only http/https URLs are allowed", 400);
    }
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    if (request.signal) {
      request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
    const stream = new ReadableStream({
      start(controller) {
        const sendRaw = (t) => controller.enqueue(encoder.encode(t));
        const sendComment = (t = "") => sendRaw(`: ${t}\n\n`);
        const sendSSE = (data) => {
          sendRaw(`data: ${JSON.stringify(data)}\n\n`);
        };
        (async () => {
          let reader = null;
          let decoder = null;
          let carryChunks = [];
          let carryLen = 0;
          let totalUrls = 0;
          let textChars = 0;
          let lastBeat = 0;
          let aborted = false;
          let pendingDecodeChunks = [];
          let pendingDecodeBytes = 0;
          const gzipStats = {
            membersStarted: 0,
            membersCompleted: 0,
          };
          function emitUrlsFromText(text) {
            if (!text) return;
            const batch = extractUrls(text);
            if (batch.length) {
              totalUrls += batch.length;
              sendSSE({
                type: "urls",
                urls: batch,
                total: totalUrls,
              });
            }
          }
          function appendCarry(text) {
            if (!text) return;
            carryChunks.push(text);
            carryLen += text.length;
          }
          function processCarryCut(cut) {
            if (cut <= 0) return;
            const parts = splitChunksAt(carryChunks, cut);
            carryChunks = parts.tail ? [parts.tail] : [];
            carryLen = parts.tail.length;
            emitUrlsFromText(parts.head);
          }
          function emitCarry() {
            if (!carryLen) return;
            const text = joinStrings(carryChunks);
            carryChunks = [];
            carryLen = 0;
            emitUrlsFromText(text);
          }
          function processDecodedText(text) {
            if (!text) return;
            textChars += text.length;
            if (textChars > MAX_TEXT_CHARS) {
              sendSSE({
                type: "error",
                error: "Decompressed text exceeds limit",
                textChars,
                gzipMembers: gzipStats.membersCompleted,
              });
              aborted = true;
              return;
            }
            appendCarry(text);
            const cut = findCutPoint(carryChunks, carryLen);
            if (cut > 0) {
              processCarryCut(cut);
            }
            if (textChars - lastBeat >= HEARTBEAT_CHARS) {
              sendComment("ping");
              lastBeat = textChars;
            }
          }
          function queueDecodeChunk(value) {
            pendingDecodeChunks.push(value);
            pendingDecodeBytes += value.length;
          }
          function flushDecodedBytes(force = false) {
            if (!decoder) return;
            if (!force && pendingDecodeBytes < DECODE_BATCH_BYTES) return;
            if (pendingDecodeBytes === 0) return;
            const merged = concatUint8Chunks(pendingDecodeChunks, pendingDecodeBytes);
            pendingDecodeChunks = [];
            pendingDecodeBytes = 0;
            const text = decoder.decode(merged, { stream: true });
            processDecodedText(text);
          }
          try {
            sendComment("open");
            const upstream = await fetch(target, {
              method: "GET",
              redirect: "manual",
              signal: abortController.signal,
              headers: {
                "Accept-Encoding": "identity",
              },
            });
            if (upstream.status === 0 || (upstream.status >= 300 && upstream.status < 400)) {
              sendSSE({
                type: "error",
                error: `Redirect not allowed: HTTP ${upstream.status}`,
                location: upstream.headers.get("location") || null,
              });
              return;
            }
            if (upstream.status !== 200) {
              sendSSE({
                type: "error",
                error: `Upstream failed: HTTP ${upstream.status}`,
              });
              return;
            }
            if (!upstream.body) {
              sendSSE({
                type: "error",
                error: "Empty body",
              });
              return;
            }
            sendSSE({
              type: "meta",
              status: "started",
              url: target,
              contentType: upstream.headers.get("content-type") || null,
              contentEncoding: upstream.headers.get("content-encoding") || null,
              gunzip: "js-split-native-decompressionstream-multi-member",
            });
            const decompressed = upstream.body.pipeThrough(
              createMultiMemberGunzipStream({
                onMemberStart(n) {
                  gzipStats.membersStarted = n;
                },
                onMemberEnd(completed) {
                  gzipStats.membersCompleted = completed;
                },
              }),
            );
            reader = decompressed.getReader();
            decoder = new TextDecoder("utf-8");
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value || !value.length) continue;
              queueDecodeChunk(value);
              flushDecodedBytes(false);
              if (aborted) {
                break;
              }
            }
            if (!aborted) {
              flushDecodedBytes(true);
              if (!aborted) {
                const tail = decoder.decode();
                if (tail) {
                  processDecodedText(tail);
                }
              }
              if (!aborted) {
                emitCarry();
                sendSSE({
                  type: "done",
                  status: "completed",
                  totalUrls,
                  textChars,
                  gzipMembers: gzipStats.membersCompleted,
                });
              }
            }
          } catch (e) {
            try {
              if (decoder) {
                try {
                  flushDecodedBytes(true);
                  const tail = decoder.decode();
                  if (tail) processDecodedText(tail);
                  emitCarry();
                } catch {}
              }
              sendSSE({
                type: "error",
                error: e?.message || String(e),
                totalUrls,
                textChars,
                gzipMembers: gzipStats.membersCompleted,
                gzipMembersStarted: gzipStats.membersStarted,
              });
            } catch {}
          } finally {
            if (reader) {
              try {
                await reader.cancel();
              } catch {}
            }
            try {
              controller.close();
            } catch {}
          }
        })();
      },
      cancel() {
        abortController.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
