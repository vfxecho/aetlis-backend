'use strict';

class VanisReader {
    constructor(buffer) {
        if (!Buffer.isBuffer(buffer)) {
            buffer = Buffer.from(buffer);
        }
        this.buffer = buffer;
        this.offset = 0;
    }

    length() {
        return this.buffer.length;
    }

    remaining() {
        return this.buffer.length - this.offset;
    }

    readUInt8() {
        if (this.remaining() < 1) throw new RangeError('VanisReader: readUInt8 out of bounds');
        const value = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return value;
    }

    readInt8() {
        if (this.remaining() < 1) throw new RangeError('VanisReader: readInt8 out of bounds');
        const value = this.buffer.readInt8(this.offset);
        this.offset += 1;
        return value;
    }

    readUInt16() {
        if (this.remaining() < 2) throw new RangeError('VanisReader: readUInt16 out of bounds');
        const value = this.buffer.readUInt16LE(this.offset);
        this.offset += 2;
        return value;
    }

    readInt16() {
        if (this.remaining() < 2) throw new RangeError('VanisReader: readInt16 out of bounds');
        const value = this.buffer.readInt16LE(this.offset);
        this.offset += 2;
        return value;
    }

    readUInt32() {
        if (this.remaining() < 4) throw new RangeError('VanisReader: readUInt32 out of bounds');
        const value = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return value;
    }

    readInt32() {
        if (this.remaining() < 4) throw new RangeError('VanisReader: readInt32 out of bounds');
        const value = this.buffer.readInt32LE(this.offset);
        this.offset += 4;
        return value;
    }

    readFloat32() {
        if (this.remaining() < 4) throw new RangeError('VanisReader: readFloat32 out of bounds');
        const value = this.buffer.readFloatLE(this.offset);
        this.offset += 4;
        return value;
    }

    readBytes(length) {
        if (length < 0 || this.remaining() < length) {
            throw new RangeError('VanisReader: readBytes out of bounds');
        }
        const start = this.offset;
        const end = start + length;
        this.offset = end;
        return this.buffer.slice(start, end);
    }

    readStringUTF8(maxLength = 1024) {
        const start = this.offset;
        const end = this.buffer.indexOf(0, start);
        if (end === -1) throw new RangeError('VanisReader: missing string terminator');
        if (end - start > maxLength) throw new RangeError('VanisReader: string too long');
        const value = this.buffer.toString('utf8', start, end);
        this.offset = end + 1;
        return value;
    }

    skip(count) {
        if (count < 0 || this.offset + count > this.buffer.length) {
            throw new RangeError('VanisReader: skip out of bounds');
        }
        this.offset += count;
    }

    sliceRemaining() {
        return this.buffer.slice(this.offset);
    }
}

module.exports = VanisReader;

