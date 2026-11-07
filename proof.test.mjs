import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanScreenshot, PROOF_LIMITS, referenceOf, sniffImage } from './proof.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function jpegSegment(marker, data) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
}

function samplePng(secret = 'GPS 40.7,-74.0') {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', Buffer.alloc(13, 1)),
    pngChunk('tEXt', Buffer.from(`Comment\0${secret}`)),
    pngChunk('eXIf', Buffer.from(secret)),
    pngChunk('IDAT', Buffer.from('pixels')),
    pngChunk('IEND'),
  ]);
}

function sampleJpeg(secret = 'GPS 40.7,-74.0') {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from('JFIF\0keep')),
    jpegSegment(0xe1, Buffer.from(`Exif\0\0${secret}`)),
    jpegSegment(0xfe, Buffer.from(secret)),
    jpegSegment(0xdb, Buffer.from('quant')),
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02]),
    Buffer.from('scan data'),
    Buffer.from([0xff, 0xd9]),
  ]);
}

test('screenshots are checked by their bytes, not their stated type', () => {
  assert.equal(sniffImage(samplePng()), 'image/png');
  assert.equal(sniffImage(sampleJpeg()), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('<svg onload=alert(1)>')), null);

  const spoofed = cleanScreenshot({ type: 'image/jpeg', data: samplePng().toString('base64') });
  assert.equal(spoofed.type, 'image/png');
  assert.throws(() => cleanScreenshot({ type: 'image/png', data: Buffer.from('<html>').toString('base64') }), /PNG or JPEG/);
  assert.throws(() => cleanScreenshot({ type: 'image/gif', data: Buffer.from('GIF89a....').toString('base64') }), /PNG or JPEG/);
  assert.throws(() => cleanScreenshot({ type: 'image/png' }), /Attach the screenshot/);

  const huge = Buffer.concat([samplePng(), Buffer.alloc(PROOF_LIMITS.maxImageBytes)]);
  assert.throws(() => cleanScreenshot({ data: huge.toString('base64') }), (error) => error.status === 413);
  assert.throws(() => cleanScreenshot({ data: samplePng().subarray(0, 40).toString('base64') }), /damaged/);
});

test('location, camera, and text metadata are stripped and the picture is kept', () => {
  const png = cleanScreenshot({ data: samplePng().toString('base64') }).bytes;
  assert.equal(png.includes('GPS'), false);
  assert.equal(png.includes('tEXt'), false);
  assert.equal(png.includes('IHDR'), true);
  assert.equal(png.includes('pixels'), true);
  assert.equal(png.subarray(-8, -4).toString('latin1'), 'IEND');

  const jpeg = cleanScreenshot({ data: sampleJpeg().toString('base64') }).bytes;
  assert.equal(jpeg.includes('GPS'), false);
  assert.equal(jpeg.includes('Exif'), false);
  assert.equal(jpeg.includes('JFIF'), true);
  assert.equal(jpeg.includes('quant'), true);
  assert.equal(jpeg.includes('scan data'), true);
});

test('a transaction reference is trimmed and kept short', () => {
  assert.equal(referenceOf('  CA   #7781 2 '), 'CA #7781 2');
  assert.equal(referenceOf(undefined), '');
  assert.throws(() => referenceOf('x'.repeat(PROOF_LIMITS.maxReference + 1)), /under 100/);
});
