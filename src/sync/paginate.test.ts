import { describe, it, expect } from 'vitest';
import { paginate, streamPages } from './paginate.js';

describe('paginate (streaming, avoids OOM)', () => {
  it('iterates all pages and stops on a short page', async () => {
    const pages: Record<number, number[]> = { 1: [1, 2, 3], 2: [4, 5, 6], 3: [7] };
    const fetchPage = async (p: number): Promise<number[]> => pages[p] ?? [];
    const out: number[] = [];
    for await (const x of paginate(fetchPage, { pageSize: 3 })) out.push(x);
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('stops on an empty page without pageSize', async () => {
    const pages: Record<number, number[]> = { 1: [1, 2], 2: [] };
    const fetchPage = async (p: number): Promise<number[]> => pages[p] ?? [];
    const out: number[] = [];
    for await (const x of paginate(fetchPage)) out.push(x);
    expect(out).toEqual([1, 2]);
  });

  it('streamPages yields the pages', async () => {
    const pages: Record<number, number[]> = { 1: [1, 2], 2: [3] };
    const fetchPage = async (p: number): Promise<number[]> => pages[p] ?? [];
    const got: number[][] = [];
    for await (const page of streamPages(fetchPage, { pageSize: 2 })) got.push(page);
    expect(got).toEqual([[1, 2], [3]]);
  });

  it('throws once paginate exceeds MAX_PAGES (fetchPage not advancing)', async () => {
    // Always returns a full page -> would loop forever without the guard.
    const fetchPage = async (): Promise<number[]> => [1, 2, 3];
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of paginate(fetchPage, { pageSize: 3 })) {
        // drain
      }
    }).rejects.toThrow(/exceeded MAX_PAGES/);
  });

  it('throws once streamPages exceeds MAX_PAGES (fetchPage not advancing)', async () => {
    const fetchPage = async (): Promise<number[]> => [1, 2, 3];
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of streamPages(fetchPage, { pageSize: 3 })) {
        // drain
      }
    }).rejects.toThrow(/exceeded MAX_PAGES/);
  });
});
