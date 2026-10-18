import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type DesignType = {
  id: string; name: string; what: string; meaning: string;
  vocabulary: { term: string; def: string }[]; keywords: string[]; prompt: string; brief: string;
};
export type DesignItem = {
  id: string; type: string; src: string; shots?: string[]; title: string; keywords: string[]; sourceUrl: string | null;
};
export type DB = { types: DesignType[]; items: DesignItem[] };

export const loadDb = async (): Promise<DB> =>
  JSON.parse(await readFile(path.join(process.cwd(), 'src/data/designs.json'), 'utf8'));

export const itemPrompt = (t: DesignType, i: DesignItem) => `${t.prompt}, ${i.keywords.join(', ')}`;
export const itemBrief = (t: DesignType, i: DesignItem) =>
  `${t.brief}\n\nReferencia concreta: ${i.title}. Rasgos: ${i.keywords.join(', ')}.`;
