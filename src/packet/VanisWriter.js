'use strict';

class VanisWriter {
    constructor(initialSize = 128) {
        this.buffer = Buffer.allocUnsafe(initialSize);
        this.offset = 0;
    }

    ensure(size) {
        if (this.offset + size <= this.buffer.length) return;
        let newLength = this.buffer.length;
        while (this.offset + size > newLength) {
            newLength *= 2;
        }
        const next = Buffer.allocUnsafe(newLength);
        this.buffer.copy(next, 0, 0, this.offset);
        this.buffer = next;
    }

    writeUInt8(value) {
        this.ensure(1);
        this.buffer.writeUInt8(value & 0xFF, this.offset);
        this.offset += 1;
    }

    writeInt8(value) {
        this.ensure(1);
        this.buffer.writeInt8(value | 0, this.offset);
        this.offset += 1;
    }

    writeUInt16(value) {
        this.ensure(2);
        this.buffer.writeUInt16LE(value & 0xFFFF, this.offset);
        this.offset += 2;
    }

    writeInt16(value) {
        this.ensure(2);
        // Clamp to int16 range to prevent crash with large cell sizes
        value = Math.max(-32768, Math.min(32767, value | 0));
        this.buffer.writeInt16LE(value, this.offset);
        this.offset += 2;
    }

    writeUInt32(value) {
        this.ensure(4);
        this.buffer.writeUInt32LE(value >>> 0, this.offset);
        this.offset += 4;
    }

    writeInt32(value) {
        this.ensure(4);
        this.buffer.writeInt32LE(value | 0, this.offset);
        this.offset += 4;
    }

    writeFloat32(value) {
        this.ensure(4);
        this.buffer.writeFloatLE(value, this.offset);
        this.offset += 4;
    }

    writeFloat64(value) {
        this.ensure(8);
        this.buffer.writeDoubleLE(value, this.offset);
        this.offset += 8;
    }

    writeUInt16BE(value) {
        this.ensure(2);
        this.buffer.writeUInt16BE(value & 0xFFFF, this.offset);
        this.offset += 2;
    }

    writeStringUTF8(value = '') {
        const str = value == null ? '' : String(value);
        const stringBuffer = Buffer.from(str, 'utf8');
        this.ensure(stringBuffer.length + 1);
        stringBuffer.copy(this.buffer, this.offset);
        this.offset += stringBuffer.length;
        this.buffer[this.offset] = 0;
        this.offset += 1;
    }

    writeBuffer(view) {
        if (!view || !view.length) return;
        const buf = Buffer.isBuffer(view) ? view : Buffer.from(view);
        this.ensure(buf.length);
        buf.copy(this.buffer, this.offset);
        this.offset += buf.length;
    }

    finalize() {
        return this.buffer.slice(0, this.offset);
    }
}

module.exports = VanisWriter;

