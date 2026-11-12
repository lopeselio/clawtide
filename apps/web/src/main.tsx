import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './style.css';

// The board's digits are drawn once into canvas textures, so wait (briefly) for the display font first;
// otherwise the first board would keep the fallback face.
const fontReady = Promise.race([
  document.fonts?.load('100px "Lilita One"').catch(() => undefined) ?? Promise.resolve(),
  new Promise((r) => setTimeout(r, 1500)),
]);
void fontReady.then(() => createRoot(document.getElementById('root')!).render(<App />));
