const URL_RE = /https?:\/\/[^\s"'<>`{}|\\^\[\]]+/gi;
const MAX_CARRY = 8192;
const MAX_URL_LEN = 4096;
const MAX_TEXT_CHARS = 1 << 30;
const HEARTBEAT_CHARS = 2 << 20;
const MAX_GZIP_MEMBERS = 1 << 20;
const GUNZIP_OUTPUT_CHUNK_SIZE = 64 * 1024;
const FAST_BITS = 16;
const FAST_SIZE = 1 << FAST_BITS;
const FAST_MASK = FAST_SIZE - 1;
const EMPTY_U8 = new Uint8Array(0);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();
const CL_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
const LEN_BASE = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]);
const LEN_EXTRA = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DIST_BASE = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]);
const DIST_EXTRA = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
let FIXED_LITLEN_TREE = null;
let FIXED_DIST_TREE = null;
function isDelim(c) {
  if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b) {
    return true;
  }
  switch (c) {
    case 0x22:
    case 0x27:
    case 0x3c:
    case 0x3e:
    case 0x60:
    case 0x7b:
    case 0x7d:
    case 0x7c:
    case 0x5c:
    case 0x5e:
    case 0x5b:
    case 0x5d:
      return true;
  }
  return false;
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
  let end = u.length;
  while (end > 0) {
    const c = u.charCodeAt(end - 1);
    if (c === 0x2e || c === 0x2c || c === 0x3b || c === 0x3a || c === 0x21 || c === 0x3f) {
      end--;
      continue;
    }
    break;
  }
  return end === u.length ? u : u.slice(0, end);
}
function extractUrls(text) {
  const out = [];
  const seen = new Set();
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
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
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
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
    left: Int32Array.from(left),
    right: Int32Array.from(right),
    sym: Int32Array.from(sym),
    maxLen,
    fastTable,
  };
}
function getFixedTrees() {
  if (FIXED_LITLEN_TREE && FIXED_DIST_TREE) {
    return {
      litlen: FIXED_LITLEN_TREE,
      dist: FIXED_DIST_TREE,
    };
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
  return {
    litlen: FIXED_LITLEN_TREE,
    dist: FIXED_DIST_TREE,
  };
}
class Inflate {
  constructor(options = {}) {
    this.options = options;
    this.chunkSize = options.chunkSize || GUNZIP_OUTPUT_CHUNK_SIZE;
    this.onData = null;
    this.err = 0;
    this.msg = "";
    this.ended = false;
    this.strm = {
      input: EMPTY_U8,
      next_in: 0,
      avail_in: 0,
      msg: "",
    };
    this.input = EMPTY_U8;
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
    this.lengthBase = 0;
    this.lengthExtra = 0;
    this.matchLength = 0;
    this.distBase = 0;
    this.distExtra = 0;
    this.matchDistance = 0;
    this.storedRemaining = 0;
    this.output = new Uint8Array(this.chunkSize);
    this.spareOutput = new Uint8Array(this.chunkSize);
    this.outpos = 0;
    this.window = new Uint8Array(32768);
    this.wpos = 0;
    this.crc = 0xffffffff;
    this.totalOut = 0;
  }
  push(chunk, final = false) {
    try {
      chunk = asUint8Array(chunk);
      this._appendInput(chunk);
      this._process(final);
      this._updateStrm();
      return true;
    } catch (e) {
      this.err = -3;
      this.msg = e?.message || String(e);
      this.strm.msg = this.msg;
      this._updateStrm();
      return false;
    }
  }
  _appendInput(chunk) {
    if (this.pos > 0) {
      const bufferedBytes = this.bitlen >>> 3;
      const keepPos = this.pos - bufferedBytes;
      this.input = keepPos >= this.input.length ? EMPTY_U8 : this.input.subarray(keepPos);
      this.pos = bufferedBytes;
    }
    if (!chunk || chunk.length === 0) return;
    if (this.input.length === 0) {
      this.input = chunk;
      return;
    }
    const merged = new Uint8Array(this.input.length + chunk.length);
    merged.set(this.input, 0);
    merged.set(chunk, this.input.length);
    this.input = merged;
  }
  _updateStrm() {
    const bufferedBytes = this.bitlen >>> 3;
    const nextIn = this.pos >= bufferedBytes ? this.pos - bufferedBytes : 0;
    this.strm.input = this.input;
    this.strm.next_in = nextIn;
    this.strm.avail_in = Math.max(0, this.input.length - nextIn);
  }
  _process() {
    while (!this.ended) {
      switch (this.state) {
        case "GZIP_HEADER":
          if (!this._parseGzipHeader()) return;
          break;
        case "BLOCK_HEADER":
          if (!this._parseBlockHeader()) return;
          break;
        case "STORED_LEN":
          if (!this._parseStoredLen()) return;
          break;
        case "STORED_COPY":
          if (!this._parseStoredCopy()) return;
          break;
        case "DYNAMIC":
          if (!this._parseDynamic()) return;
          break;
        case "HUFFMAN":
          if (!this._parseHuffman()) return;
          break;
        case "LEN_EXTRA":
          if (!this._parseLengthExtra()) return;
          break;
        case "DIST":
          if (!this._parseDistance()) return;
          break;
        case "DIST_EXTRA":
          if (!this._parseDistanceExtra()) return;
          break;
        case "COPY":
          this._copyMatch();
          break;
        case "FOOTER":
          if (!this._parseFooter()) return;
          break;
        case "DONE":
          this.ended = true;
          return;
        default:
          throw new Error(`Invalid inflate state: ${this.state}`);
      }
    }
  }
  _readBits(n) {
    if (n === 0) return 0;
    let bitbuf = this.bitbuf;
    let bitlen = this.bitlen;
    let pos = this.pos;
    const input = this.input;
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
    const input = this.input;
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
        if (pos >= input.length) {
          return null;
        }
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
          if (this.pos + 10 > this.input.length) {
            return false;
          }
          const p = this.pos;
          const b = this.input;
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
            if (this.pos + 2 > this.input.length) {
              return false;
            }
            this.gzExtraRemaining = this.input[this.pos] | (this.input[this.pos + 1] << 8);
            this.pos += 2;
            this.gzStage = 2;
          } else {
            this.gzStage = 3;
          }
          continue;
        }
        case 2: {
          if (this.gzExtraRemaining > 0) {
            const n = Math.min(this.gzExtraRemaining, this.input.length - this.pos);
            this.pos += n;
            this.gzExtraRemaining -= n;
            if (this.gzExtraRemaining > 0) {
              return false;
            }
          }
          this.gzStage = 3;
          continue;
        }
        case 3: {
          if (this.gzFlags & 0x08) {
            while (this.pos < this.input.length) {
              if (this.input[this.pos++] === 0) {
                this.gzStage = 4;
                break;
              }
            }
            if (this.gzStage !== 4) {
              return false;
            }
          } else {
            this.gzStage = 4;
          }
          continue;
        }
        case 4: {
          if (this.gzFlags & 0x10) {
            while (this.pos < this.input.length) {
              if (this.input[this.pos++] === 0) {
                this.gzStage = 5;
                break;
              }
            }
            if (this.gzStage !== 5) {
              return false;
            }
          } else {
            this.gzStage = 5;
          }
          continue;
        }
        case 5: {
          if (this.gzFlags & 0x02) {
            if (this.pos + 2 > this.input.length) {
              return false;
            }
            this.pos += 2;
          }
          this.crc = 0xffffffff;
          this.totalOut = 0;
          this.wpos = 0;
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
    if (bits === null) {
      return false;
    }
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
    if (this.pos + 4 > this.input.length) {
      return false;
    }
    const len = this.input[this.pos] | (this.input[this.pos + 1] << 8);
    const nlen = this.input[this.pos + 2] | (this.input[this.pos + 3] << 8);
    this.pos += 4;
    if (((len ^ 0xffff) & 0xffff) !== nlen) {
      throw new Error("Invalid stored deflate block length");
    }
    this.storedRemaining = len;
    if (this.storedRemaining === 0) {
      this._endBlock();
    } else {
      this.state = "STORED_COPY";
    }
    return true;
  }
  _parseStoredCopy() {
    if (this.storedRemaining === 0) {
      this._endBlock();
      return true;
    }
    const avail = this.input.length - this.pos;
    if (avail <= 0) {
      return false;
    }
    const n = Math.min(avail, this.storedRemaining);
    this._emitBytes(this.input, this.pos, n);
    this.pos += n;
    this.storedRemaining -= n;
    if (this.storedRemaining > 0) {
      return false;
    }
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
          if (v === null) {
            return false;
          }
          this.hlit = v + 257;
          this.dynStage = 1;
          continue;
        }
        case 1: {
          const v = this._readBits(5);
          if (v === null) {
            return false;
          }
          this.hdist = v + 1;
          this.dynStage = 2;
          continue;
        }
        case 2: {
          const v = this._readBits(4);
          if (v === null) {
            return false;
          }
          this.hclen = v + 4;
          this.dynCLens = new Uint8Array(19);
          this.dynCLIndex = 0;
          this.dynStage = 3;
          continue;
        }
        case 3: {
          while (this.dynCLIndex < this.hclen) {
            const v = this._readBits(3);
            if (v === null) {
              return false;
            }
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
              if (extra === null) {
                return false;
              }
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
            if (sym === null) {
              return false;
            }
            if (sym < 16) {
              this.dynLengths[this.dynIndex++] = sym;
              continue;
            }
            if (sym === 16) {
              if (this.dynIndex === 0) {
                throw new Error("Invalid dynamic Huffman repeat");
              }
              this.dynPendingRepeat = {
                extra: 2,
                base: 3,
                value: this.dynLengths[this.dynIndex - 1],
              };
              continue;
            }
            if (sym === 17) {
              this.dynPendingRepeat = {
                extra: 3,
                base: 3,
                value: 0,
              };
              continue;
            }
            if (sym === 18) {
              this.dynPendingRepeat = {
                extra: 7,
                base: 11,
                value: 0,
              };
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
      if (sym === null) {
        return false;
      }
      if (sym < 256) {
        this._emitByte(sym);
        continue;
      }
      if (sym === 256) {
        this._endBlock();
        return true;
      }
      if (sym > 285) {
        throw new Error("Invalid literal/length code");
      }
      const idx = sym - 257;
      this.lengthBase = LEN_BASE[idx];
      this.lengthExtra = LEN_EXTRA[idx];
      if (this.lengthExtra) {
        this.state = "LEN_EXTRA";
      } else {
        this.matchLength = this.lengthBase;
        this.state = "DIST";
      }
      return true;
    }
  }
  _parseLengthExtra() {
    const extra = this._readBits(this.lengthExtra);
    if (extra === null) {
      return false;
    }
    this.matchLength = this.lengthBase + extra;
    this.state = "DIST";
    return true;
  }
  _parseDistance() {
    const sym = this._decodeSymbol(this.distTree);
    if (sym === null) {
      return false;
    }
    if (sym > 29) {
      throw new Error("Invalid distance code");
    }
    this.distBase = DIST_BASE[sym];
    this.distExtra = DIST_EXTRA[sym];
    if (this.distExtra) {
      this.state = "DIST_EXTRA";
    } else {
      this.matchDistance = this.distBase;
      this.state = "COPY";
    }
    return true;
  }
  _parseDistanceExtra() {
    const extra = this._readBits(this.distExtra);
    if (extra === null) {
      return false;
    }
    this.matchDistance = this.distBase + extra;
    this.state = "COPY";
    return true;
  }
  _copyMatch() {
    const distance = this.matchDistance;
    if (distance <= 0 || distance > 32768 || distance > this.totalOut) {
      throw new Error("Invalid deflate distance");
    }
    const len = this.matchLength;
    if (distance >= len) {
      let srcPos = this.wpos - distance;
      if (srcPos < 0) srcPos += 32768;
      if (srcPos + len <= 32768) {
        this._emitBytes(this.window, srcPos, len);
      } else {
        const first = 32768 - srcPos;
        this._emitBytes(this.window, srcPos, first);
        this._emitBytes(this.window, 0, len - first);
      }
    } else {
      const window = this.window;
      const crcTable = CRC_TABLE;
      let out = this.output;
      let outpos = this.outpos;
      let wpos = this.wpos;
      let srcPos = (wpos - distance + 32768) & 32767;
      let remaining = len;
      let totalOut = this.totalOut;
      let crc = this.crc;
      while (remaining > 0) {
        if (outpos === out.length) {
          this.output = out;
          this.outpos = outpos;
          this.wpos = wpos;
          this.totalOut = totalOut;
          this.crc = crc;
          this._flushOutput();
          out = this.output;
          outpos = this.outpos;
        }
        const b = window[srcPos];
        srcPos = (srcPos + 1) & 32767;
        window[wpos] = b;
        wpos = (wpos + 1) & 32767;
        out[outpos++] = b;
        crc = (crcTable[(crc ^ b) & 255] ^ (crc >>> 8)) >>> 0;
        totalOut++;
        remaining--;
      }
      this.outpos = outpos;
      this.wpos = wpos;
      this.totalOut = totalOut;
      this.crc = crc;
      if (outpos === out.length) {
        this._flushOutput();
      }
    }
    this.matchLength = 0;
    this.matchDistance = 0;
    this.state = "HUFFMAN";
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
    if (this.pos + 8 > this.input.length) {
      return false;
    }
    const p = this.pos;
    const b = this.input;
    const storedCrc = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
    const storedSize = (b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24)) >>> 0;
    const actualCrc = (this.crc ^ 0xffffffff) >>> 0;
    const actualSize = this.totalOut >>> 0;
    if (storedCrc !== actualCrc) {
      throw new Error("Gzip CRC check failed");
    }
    if (storedSize !== actualSize) {
      throw new Error("Gzip size check failed");
    }
    this.pos += 8;
    this._flushOutput();
    this.state = "DONE";
    this.ended = true;
    return true;
  }
  _emitByte(byte) {
    byte &= 255;
    const window = this.window;
    const out = this.output;
    const crcTable = CRC_TABLE;
    window[this.wpos] = byte;
    this.wpos = (this.wpos + 1) & 32767;
    out[this.outpos++] = byte;
    this.crc = (crcTable[(this.crc ^ byte) & 255] ^ (this.crc >>> 8)) >>> 0;
    this.totalOut++;
    if (this.outpos === out.length) {
      this._flushOutput();
    }
  }
  _emitBytes(src, start, len) {
    if (len <= 0) return;
    const window = this.window;
    const crcTable = CRC_TABLE;
    let out = this.output;
    let outpos = this.outpos;
    let wpos = this.wpos;
    let totalOut = this.totalOut;
    let crc = this.crc;
    while (len > 0) {
      if (outpos === out.length) {
        this.output = out;
        this.outpos = outpos;
        this.wpos = wpos;
        this.totalOut = totalOut;
        this.crc = crc;
        this._flushOutput();
        out = this.output;
        outpos = this.outpos;
      }
      let n = len;
      const outAvail = out.length - outpos;
      if (n > outAvail) n = outAvail;
      const winAvail = 32768 - wpos;
      if (n > winAvail) n = winAvail;
      const end = start + n;
      const chunk = src.subarray(start, end);
      for (let i = 0; i < n; i++) {
        const byte = chunk[i];
        crc = (crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)) >>> 0;
      }
      out.set(chunk, outpos);
      window.set(chunk, wpos);
      outpos += n;
      wpos += n;
      if (wpos === 32768) wpos = 0;
      totalOut += n;
      start = end;
      len -= n;
    }
    this.outpos = outpos;
    this.wpos = wpos;
    this.totalOut = totalOut;
    this.crc = crc;
    if (outpos === out.length) {
      this._flushOutput();
    }
  }
  _flushOutput() {
    if (!this.outpos) return;
    const outBuf = this.output;
    const out = this.outpos === outBuf.length ? outBuf : new Uint8Array(outBuf.buffer, outBuf.byteOffset, this.outpos);
    this.output = this.spareOutput;
    this.spareOutput = outBuf;
    this.outpos = 0;
    if (this.onData) {
      this.onData(out);
    }
  }
}
function createMultiMemberGunzipStream(options = {}) {
  const { maxMembers = MAX_GZIP_MEMBERS, chunkSize = GUNZIP_OUTPUT_CHUNK_SIZE, ignoreZeroPadding = true, onMemberStart, onMemberEnd } = options;
  let inflator = null;
  let memberNo = 0;
  let completedMembers = 0;
  function makeInflateError(inf, prefix) {
    const code = inf?.err;
    const msg = inf?.msg || inf?.strm?.msg || "";
    if (msg) return new Error(`${prefix}: ${msg}`);
    if (code) return new Error(`${prefix}: inflate status ${code}`);
    return new Error(prefix);
  }
  function stripZeroPadding(input) {
    if (!ignoreZeroPadding) return input;
    let i = 0;
    const len = input.length;
    while (i + 4 <= len && (input[i] | input[i + 1] | input[i + 2] | input[i + 3]) === 0) {
      i += 4;
    }
    while (i < len && input[i] === 0) i++;
    return i > 0 ? input.subarray(i) : input;
  }
  function startMember(controller) {
    memberNo++;
    if (memberNo > maxMembers) {
      throw new Error(`Too many gzip members: more than ${maxMembers}`);
    }
    if (onMemberStart) {
      onMemberStart(memberNo);
    }
    const inf = new Inflate({
      windowBits: 31,
      chunkSize,
    });
    inf.onData = (data) => {
      if (data && data.length) {
        controller.enqueue(data);
      }
    };
    return inf;
  }
  function getUnusedInput(inf) {
    const s = inf?.strm;
    if (!s || !s.input || !s.avail_in) {
      return EMPTY_U8;
    }
    return s.input.subarray(s.next_in, s.next_in + s.avail_in);
  }
  function processInput(input, controller) {
    input = asUint8Array(input);
    while (input.length > 0) {
      if (!inflator) {
        input = stripZeroPadding(input);
        if (input.length === 0) {
          return;
        }
        inflator = startMember(controller);
      }
      const ok = inflator.push(input, false);
      if (!ok) {
        throw makeInflateError(inflator, `Invalid gzip member #${memberNo}`);
      }
      if (inflator.ended) {
        const rest = getUnusedInput(inflator);
        completedMembers++;
        if (onMemberEnd) {
          onMemberEnd(completedMembers, memberNo);
        }
        inflator = null;
        input = rest;
        continue;
      }
      return;
    }
  }
  return new TransformStream({
    transform(chunk, controller) {
      processInput(chunk, controller);
    },
    flush(controller) {
      if (!inflator) return;
      const ok = inflator.push(EMPTY_U8, true);
      if (!ok) {
        throw makeInflateError(inflator, `Invalid gzip member #${memberNo}`);
      }
      if (!inflator.ended) {
        throw new Error(`Unexpected EOF in gzip member #${memberNo}`);
      }
      completedMembers++;
      if (onMemberEnd) {
        onMemberEnd(completedMembers, memberNo);
      }
      inflator = null;
    },
  });
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
              gunzip: "js-multi-member",
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
              const text = decoder.decode(value, { stream: true });
              if (!text) continue;
              textChars += text.length;
              if (textChars > MAX_TEXT_CHARS) {
                sendSSE({
                  type: "error",
                  error: "Decompressed text exceeds limit",
                  textChars,
                  gzipMembers: gzipStats.membersCompleted,
                });
                aborted = true;
                break;
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
            if (!aborted) {
              const tail = decoder.decode();
              if (tail) {
                appendCarry(tail);
              }
              emitCarry();
              sendSSE({
                type: "done",
                status: "completed",
                totalUrls,
                textChars,
                gzipMembers: gzipStats.membersCompleted,
              });
            }
          } catch (e) {
            try {
              if (decoder) {
                try {
                  const tail = decoder.decode();
                  if (tail) appendCarry(tail);
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
