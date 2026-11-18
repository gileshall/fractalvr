// The desktop hint (index.html #help): the few keys a first look needs, and where the source is.
// It stays until LINGER after the first key or click, or until the menu opens, then fades out
// for good; the menu's Info tab keeps the full list.
const LINGER = 20000;

export function startHint() {
  const el = document.getElementById('help');
  if (!el) throw new Error('index.html has no #help');
  let timer = 0;
  const fade = () => {
    clearTimeout(timer);
    removeEventListener('keydown', first, true);
    removeEventListener('pointerdown', first, true);
    if (el.hidden || el.classList.contains('gone')) return;
    el.addEventListener('transitionend', () => { el.hidden = true; }, { once: true });
    el.classList.add('gone');
  };
  const first = () => {
    removeEventListener('keydown', first, true);
    removeEventListener('pointerdown', first, true);
    timer = setTimeout(fade, LINGER);
  };
  addEventListener('keydown', first, true);
  addEventListener('pointerdown', first, true);
  return { fade };
}
