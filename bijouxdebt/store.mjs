import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const TITLES = ['sub', 'devotee', 'slave', 'atm', 'piggy'];

export function emptyBook() {
  return {
    settings: {
      tiers: [
        { id: 'spark', name: 'Spark', amountCents: 1100, blurb: 'A small glint on the book.' },
        { id: 'setting', name: 'Setting', amountCents: 3300, blurb: 'Hold a place in the setting.' },
        { id: 'stone', name: 'Stone', amountCents: 7700, blurb: 'A named stone, recorded.' },
        { id: 'bijou', name: 'Bijou', amountCents: 11100, blurb: 'The piece itself.' },
      ],
    },
    subs: [],
    sessions: [],
    invoices: [],
  };
}

export async function hashSecret(secret) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(secret, salt, 32)).toString('hex');
  return { salt, hash };
}

export async function verifySecret(secret, salt, hash) {
  if (!salt || !hash || typeof secret !== 'string') return false;
  const actual = await scryptAsync(secret, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function newId(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

export function createStore(file) {
  let data = emptyBook();
  let chain = Promise.resolve();

  async function load() {
    try {
      data = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      data = emptyBook();
    }
    if (!data.settings?.tiers) data = emptyBook();
    if (!Array.isArray(data.subs)) data.subs = [];
    if (!Array.isArray(data.sessions)) data.sessions = [];
    if (!Array.isArray(data.invoices)) data.invoices = [];
  }

  async function persist() {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, file);
  }

  function update(mutator) {
    const run = chain.then(async () => {
      const snapshot = structuredClone(data);
      try {
        const result = await mutator(data);
        await persist();
        return result;
      } catch (error) {
        data = snapshot;
        throw error;
      }
    });
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  return {
    load,
    update,
    snapshot() {
      return data;
    },
  };
}
