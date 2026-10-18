import type { APIRoute } from 'astro';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const prerender = false;

const DATA_FILE = path.join(process.cwd(), 'src/data/designs.json');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const MAX_BYTES = 5 * 1024 * 1024; // límite de Claude por imagen
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' } as const;
type Mime = keyof typeof MIME_EXT;
type Shot = { data: Buffer; mime: Mime };

const VIEW = { width: 1440, height: 900 };
const MAX_SHOTS = 4;
// shortcut: heurística simple para banners de cookies; si falla en muchas webs, usar @ghostery/adblocker-playwright.
const CONSENT_BUTTON = /^\s*(aceptar|acepto|accept|agree|allow|ok|entendido|got it|rechazar|reject)/i;
const CONSENT_CSS = `
  #onetrust-banner-sdk, #onetrust-consent-sdk, #CybotCookiebotDialog, #didomi-host, #usercentrics-root,
  .cc-window, .qc-cmp2-container, [id*="cookie" i], [class*="cookie-banner" i], [class*="consent" i] { display: none !important; }
  html, body { overflow: auto !important; }`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const isMime = (m: string): m is Mime => m in MIME_EXT;

async function screenshotPage(url: string): Promise<Shot[]> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEW });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.getByRole('button', { name: CONSENT_BUTTON }).first().click({ timeout: 2_000 }).catch(() => {});
    await page.addStyleTag({ content: CONSENT_CSS });
    // Recorre la página para disparar el lazy-load antes de capturar.
    const height = await page.evaluate(async ({ step, limit }) => {
      for (let y = 0; y < Math.min(document.documentElement.scrollHeight, limit); y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
      return document.documentElement.scrollHeight;
    }, { step: VIEW.height / 2, limit: VIEW.height * MAX_SHOTS });
    await page.waitForTimeout(500);

    const shots: Shot[] = [];
    for (let i = 0; i < MAX_SHOTS && i * VIEW.height < height - 100; i++) {
      const y = i * VIEW.height;
      const clip = { x: 0, y, width: VIEW.width, height: Math.min(VIEW.height, height - y) };
      shots.push({ data: await page.screenshot({ type: 'jpeg', quality: 80, fullPage: true, clip }), mime: 'image/jpeg' });
    }
    return shots;
  } finally {
    await browser.close();
  }
}

async function shotsFromUrl(raw: string): Promise<Shot[]> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UserError('La URL debe ser http(s).');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new UserError(`La URL respondió ${res.status}.`);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (mime.startsWith('image/')) {
    if (!isMime(mime)) throw new UserError(`Formato de imagen no soportado: ${mime}.`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_BYTES) throw new UserError('La imagen supera 5 MB.');
    return [{ data, mime }];
  }
  await res.body?.cancel();
  return screenshotPage(url.href);
}

class UserError extends Error {}

const VOCAB_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['term', 'def'],
  properties: { term: { type: 'string' }, def: { type: 'string' } },
};
const NEW_TYPE = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'what', 'meaning', 'vocabulary', 'keywords', 'prompt', 'brief'],
  properties: {
    id: { type: 'string', description: 'id del estilo nuevo en snake_case' },
    name: { type: 'string' },
    what: { type: 'string' },
    meaning: { type: 'string' },
    vocabulary: { type: 'array', items: VOCAB_ITEM },
    keywords: { type: 'array', items: { type: 'string' } },
    prompt: { type: 'string' },
    brief: { type: 'string' },
  },
};
const NEW = '__nuevo__';
// typeId solo puede ser un id existente o NEW: así Claude no puede inventar variantes del nombre de un estilo.
const schemaFor = (typeIds: string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['typeId', 'newType', 'title', 'keywords'],
  properties: {
    typeId: { type: 'string', enum: [...typeIds, NEW] },
    newType: { anyOf: [{ type: 'null' }, NEW_TYPE] },
    title: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
  },
});

type Analysis = {
  typeId: string;
  newType: null | { id: string; name: string; what: string; meaning: string; vocabulary: { term: string; def: string }[]; keywords: string[]; prompt: string; brief: string };
  title: string;
  keywords: string[];
};
type DB = {
  types: { id: string; name: string; what: string }[];
  items: { id: string; type: string; src: string; sourceUrl: string | null }[];
};

// shortcut: una imagen de ejemplo por estilo, hasta 12 estilos; con muchos más, elegir los candidatos por keywords antes.
const MAX_STYLE_SAMPLES = 12;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');

// Misma página aunque cambie el #ancla, la barra final o el www.
function sameUrl(a: string, b: string) {
  try {
    const norm = (u: string) => {
      const x = new URL(u);
      return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
    };
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

// Usa Claude Code en modo headless (`claude -p`) con la sesión iniciada, es decir, con la suscripción.
// Las imágenes van a una carpeta temporal y Claude solo puede usar Read sobre ellas.
async function analyze(shots: Shot[], db: DB, sourceUrl: string | null): Promise<Analysis> {
  const dir = await mkdtemp(path.join(tmpdir(), 'inspiracion-'));
  try {
    const files = await Promise.all(shots.map(async (s, i) => {
      const f = `captura-${i + 1}.${MIME_EXT[s.mime]}`;
      await writeFile(path.join(dir, f), s.data);
      return f;
    }));

    // Un ejemplo por estilo, para que compare imagen con imagen y no solo con la descripción.
    const samples = new Map<string, string>();
    await Promise.all(db.types.slice(0, MAX_STYLE_SAMPLES).map(async (t) => {
      const item = db.items.find((i) => i.type === t.id);
      if (!item) return;
      const f = `estilo-${t.id}${path.extname(item.src)}`;
      try {
        await copyFile(path.join(PUBLIC_DIR, item.src), path.join(dir, f));
        samples.set(t.id, f);
      } catch { /* sin imagen de ejemplo: se compara solo con la descripción */ }
    }));

    const typeList = db.types
      .map((t) => `- ${t.id}: ${t.name} — ${t.what}${samples.has(t.id) ? ` (ejemplo: ${samples.get(t.id)})` : ''}`)
      .join('\n');
    const prompt =
      `Lee con Read la referencia nueva: ${files.join(', ')}.\n` +
      (files.length > 1 ? `Son ${files.length} capturas consecutivas de la misma página, de arriba abajo.\n` : '') +
      (sourceUrl ? `Origen: ${sourceUrl}\n` : '') +
      (samples.size ? `Lee también los ejemplos de cada estilo existente (${[...samples.values()].join(', ')}) y compáralos visualmente con la referencia nueva.\n` : '') +
      `Estilos existentes:\n${typeList || '(ninguno todavía)'}\n\n` +
      `Devuelve typeId: el id del estilo existente que encaje, con newType = null; o "${NEW}" con newType relleno si ninguno encaja. ` +
      'Además, un title corto que describa esta pieza y 3–6 keywords propias de esta pieza que no repitan las del estilo.';
    const system =
      'Eres un director de arte que cataloga referencias de diseño web y gráfico por estilo visual. ' +
      'Clasifica la referencia en un estilo existente si comparte el mismo lenguaje visual (técnica de imagen, tipografía, paleta, composición), ' +
      'aunque el tema o el contenido sean distintos. Crea uno nuevo solo si el lenguaje visual es claramente otro. ' +
      'Escribe en español: title, name, what, meaning, vocabulary y brief. Escribe en inglés: keywords y prompt ' +
      '(el prompt debe servir para generar una imagen similar con un modelo de imagen).';

    const child = run('claude', [
      '-p', prompt,
      '--append-system-prompt', system,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schemaFor(db.types.map((t) => t.id))),
      '--tools', 'Read',
      '--allowedTools', 'Read',
      // Sin MCP, hooks ni skills del usuario: más rápido y aislado.
      '--strict-mcp-config',
      '--setting-sources', 'local',
      '--disable-slash-commands',
      '--no-session-persistence',
    ], { cwd: dir, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });
    child.child.stdin?.end(); // sin esto `claude -p` puede quedarse esperando stdin
    const { stdout } = await child;

    const out = JSON.parse(stdout);
    if (out.is_error || !out.structured_output) throw new Error(out.result || 'respuesta sin JSON estructurado');
    return out.structured_output as Analysis;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No se encontró el comando `claude`. Instala Claude Code e inicia sesión.');
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const POST: APIRoute = async ({ request }) => {
  const db: DB = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  let shots: Shot[];
  let sourceUrl: string | null = null;
  try {
    if ((request.headers.get('content-type') ?? '').includes('application/json')) {
      const { url } = await request.json();
      if (typeof url !== 'string' || !url) throw new UserError('Falta la URL.');
      // Se comprueba antes de capturar: ahorra Playwright y la llamada a Claude.
      const dup = db.items.find((i) => i.sourceUrl && sameUrl(i.sourceUrl, url));
      if (dup) return json({ error: `Esta URL ya está en la galería (estilo "${dup.type}").` }, 409);
      sourceUrl = url;
      shots = await shotsFromUrl(url);
    } else {
      const file = (await request.formData()).get('file');
      if (!(file instanceof File)) throw new UserError('Falta el archivo.');
      if (!isMime(file.type)) throw new UserError('Solo JPG, PNG, WEBP o GIF.');
      if (file.size > MAX_BYTES) throw new UserError('La imagen supera 5 MB.');
      shots = [{ data: Buffer.from(await file.arrayBuffer()), mime: file.type }];
    }
    if (!shots.length) throw new UserError('No se pudo capturar la página.');
  } catch (e) {
    return json({ error: e instanceof UserError || e instanceof TypeError ? e.message : `No se pudo obtener la imagen: ${(e as Error).message}` }, 400);
  }

  const id = createHash('sha1').update(shots[0].data).digest('hex').slice(0, 10);
  if (db.items.some((i) => i.id === id)) return json({ error: 'Este diseño ya está en la galería.' }, 409);

  let result: Analysis;
  try {
    result = await analyze(shots, db, sourceUrl);
  } catch (e) {
    return json({ error: `Error al analizar con Claude: ${(e as Error).message}` }, 502);
  }

  let typeId: string;
  if (result.typeId !== NEW) {
    // El esquema ya lo limita a ids existentes; se comprueba igual porque acaba en una ruta de disco.
    if (!db.types.some((t) => t.id === result.typeId)) return json({ error: `Claude devolvió un estilo desconocido: "${result.typeId}".` }, 502);
    typeId = result.typeId;
  } else {
    if (!result.newType) return json({ error: 'Claude propuso un estilo nuevo sin definirlo.' }, 502);
    const { id: proposed, ...rest } = result.newType;
    // El id acaba en una ruta de disco: solo se aceptan [a-z0-9_]. Si choca con uno existente, se usa ese.
    typeId = slug(proposed) || 'otros';
    if (!db.types.some((t) => t.id === typeId)) db.types.push({ id: typeId, ...rest });
  }

  const dir = path.join(PUBLIC_DIR, 'designs', typeId);
  await mkdir(dir, { recursive: true });
  const files = shots.map((s, i) => `${id}${shots.length > 1 ? `-${i}` : ''}.${MIME_EXT[s.mime]}`);
  await Promise.all(shots.map((s, i) => writeFile(path.join(dir, files[i]), s.data)));
  const srcs = files.map((f) => `/designs/${typeId}/${f}`);

  const item = { id, type: typeId, src: srcs[0], ...(srcs.length > 1 && { shots: srcs }), title: result.title, keywords: result.keywords, sourceUrl };
  db.items.push(item);
  await writeFile(DATA_FILE, JSON.stringify(db, null, 2) + '\n');
  return json(item, 201);
};
