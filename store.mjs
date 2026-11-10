import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PRODUCT_DISCLAIMER } from './ledger.mjs';

const scryptAsync = promisify(scrypt);

export function emptyBook() {
  return {
    settings: {
      clubName: 'Ohm Club',
      houseCutPercent: 0,
      topUpCode: newId(4),
      packages: [
        { id: 'start', name: 'Start', amountCents: 5000, blurb: 'First credits for the floor.' },
        { id: 'table', name: 'Table', amountCents: 15000, blurb: 'Enough to tip through a set.' },
        { id: 'vip', name: 'VIP', amountCents: 50000, blurb: 'A full night of credits.' },
      ],
      disclaimer: PRODUCT_DISCLAIMER,
    },
    dancers: [],
    customers: [],
    ledger: [],
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
    if (!data.settings || typeof data.settings !== 'object') data = emptyBook();
    if (!data.settings.disclaimer) data.settings.disclaimer = PRODUCT_DISCLAIMER;
    if (!data.settings.topUpCode) data.settings.topUpCode = newId(4);
    if (!Array.isArray(data.settings.packages)) data.settings.packages = emptyBook().settings.packages;
    if (!Array.isArray(data.dancers)) data.dancers = [];
    if (!Array.isArray(data.customers)) data.customers = [];
    if (!Array.isArray(data.ledger)) data.ledger = [];
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
