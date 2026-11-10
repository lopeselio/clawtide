import type { Difficulty, ServerMsg } from './api.ts';

// One WebSocket to the room server, plus the few things remembered on this device.

export class Net {
  private ws: WebSocket;
  private queue: string[] = [];
  closed = false;
  constructor(onMsg: (m: ServerMsg) => void, onClose: () => void) {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => { for (const q of this.queue) this.ws.send(q); this.queue = []; };
    this.ws.onmessage = (e) => { try { onMsg(JSON.parse(String(e.data)) as ServerMsg); } catch { /* ignore */ } };
    this.ws.onclose = () => { if (!this.closed) onClose(); this.closed = true; };
  }
  send(m: unknown): void {
    const s = JSON.stringify(m);
    if (this.ws.readyState === 1) this.ws.send(s); else this.queue.push(s);
  }
  close(): void { this.closed = true; this.ws.close(); }
}

const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } };

export const getName = (): string => get('clawtide:name') ?? '';
export const setName = (n: string): void => put('clawtide:name', n);
export const walkthroughDone = (): boolean => get('clawtide:walkthrough') === '1';
export const setWalkthroughDone = (): void => put('clawtide:walkthrough', '1');
export const tutorialDone = (): boolean => get('clawtide:tutorial') === '1';
export const setTutorialDone = (): void => put('clawtide:tutorial', '1');
export function getDifficulty(): Difficulty { const d = get('clawtide:difficulty'); return d === 'easy' || d === 'hard' ? d : 'normal'; }
export const setDifficulty = (d: Difficulty): void => put('clawtide:difficulty', d);
