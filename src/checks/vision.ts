/**
 * Check 6 - vision
 *
 * Gated behind --vision, one request, and deliberately not a "describe this
 * picture" test.
 *
 * The image is generated in code (a solid field with a border) so the test has
 * no external asset and its ground truth is known exactly. The question is
 * whether the image contains any written text — which is unambiguous, has a
 * one-word answer, and cannot be satisfied by a model that never looked. A
 * text-only model asked this tends to describe the image or hedge; a model that
 * looked says "no".
 *
 * That matters more than it sounds. A router that believes a model is
 * multimodal and is not will send images that come back as confident
 * descriptions of something else, and nothing in the response signals the
 * difference to the caller.
 */

import { deflateSync } from 'node:zlib';
import { defineCheck, type CheckContext } from '../registry.js';
import { fail, isRecord, pass, transportFail, warn, type ResultInit } from './_helpers.js';
import type { CheckResult, Metrics } from '../types.js';

const MAX_TOKENS = 800;

/** Built eagerly: IMAGE below is a module-level constant that needs it. */
const CRC_TABLE = buildCrcTable();

const PROMPT =
  'Look at this image. Does it contain any written text, letters, or numbers? ' +
  'Answer with exactly one word: yes or no.';

/** A solid mid-tone field with a contrasting border: no text, no ambiguity. */
const IMAGE = makePng(96, 96, { fill: [124, 77, 255], border: [16, 16, 16] });

export default defineCheck({
  name: 'vision',
  title: 'Vision',
  description: 'A generated image is correctly described, proving image input is really handled.',
  requests: 1,
  requiresVision: true,
  retry: true,
  defaultTimeoutMs: 90_000,

  async run(ctx: CheckContext): Promise<CheckResult> {
    const name = 'vision';
    const title = 'Vision';

    const http = await ctx.http.request({
      method: 'POST',
      path: '/chat/completions',
      body: ctx.body({
        model: ctx.provider.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE.base64}` } },
            ],
          },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0,
      }),
    });

    if (http.status === 0) return transportFail(name, title, http, 'vision request');

    const metrics: Metrics = {
      http_status: http.status,
      duration_ms: http.durationMs,
      image_bytes: IMAGE.bytes,
      catalog_modality: ctx.facts.supportedParameters ? 'see architecture.modality' : null,
    };

    if (!http.ok) {
      ctx.facts.visionVerdict = 'fail';
      return fail(
        name,
        title,
        `an image input request returned HTTP ${http.status}; ${
          readError(http.json) ?? 'no error detail'
        }`,
        {
          metrics,
          request: http.request,
          response: http.response,
          durationMs: http.durationMs,
        },
      );
    }

    const content = readContent(http.json);
    Object.assign(metrics, { content_chars: content.length });

    const init: ResultInit = {
      metrics,
      details: { answer: content.slice(0, 300), image: `${IMAGE.width}x${IMAGE.height} PNG, ${IMAGE.bytes} bytes` },
      request: http.request,
      response: http.response,
      durationMs: http.durationMs,
    };

    if (content.trim() === '') {
      ctx.facts.visionVerdict = 'fail';
      return fail(name, title, 'the model returned no content for an image input', init);
    }

    const answer = content.toLowerCase();
    // Look for the verdict anywhere in the reply, so a chatty answer that
    // still concludes "no" is scored correctly.
    const saysNo = /\bno\b/.test(answer);
    const saysYes = /\byes\b/.test(answer);

    ctx.facts.visionVerdict = 'fail';
    if (saysNo && !saysYes) {
      ctx.facts.visionVerdict = 'pass';
      return pass(name, title, 'the model correctly reported that the image contains no text', init);
    }

    if (saysYes) {
      return fail(
        name,
        title,
        'the model reported text in an image that provably contains none, which suggests it did not process the image',
        init,
      );
    }

    ctx.facts.visionVerdict = 'inconclusive';
    return warn(
      name,
      title,
      `the reply did not contain a clear yes or no ("${content.slice(0, 80)}"); inconclusive, so image handling is unconfirmed`,
      init,
    );
  },
});

interface GeneratedImage {
  base64: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * Minimal PNG encoder: a solid field with a 4px border, written by hand so the
 * test carries no image asset and its ground truth is exact.
 */
function makePng(width: number, height: number, colours: { fill: RGB; border: RGB }): GeneratedImage {
  const border = 4;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const onBorder = x < border || y < border || x >= width - border || y >= height - border;
      const [r, g, b] = onBorder ? colours.border : colours.fill;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw, { level: 9 });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return { base64: png.toString('base64'), bytes: png.length, width, height };
}

type RGB = [number, number, number];

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function buildCrcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function readContent(body: unknown): string {
  if (!isRecord(body)) return '';
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!isRecord(first)) return '';
  const message = first['message'];
  if (!isRecord(message)) return '';
  if (typeof message['content'] === 'string') return message['content'];
  if (Array.isArray(message['content'])) {
    return message['content']
      .map((p) => (isRecord(p) && typeof p['text'] === 'string' ? p['text'] : typeof p === 'string' ? p : ''))
      .join('');
  }
  return '';
}

function readError(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const err = body['error'];
  if (typeof err === 'string') return err;
  if (isRecord(err) && typeof err['message'] === 'string') return err['message'];
  return null;
}
