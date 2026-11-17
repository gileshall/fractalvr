// A browser can bring a page back from its own copy long after the server has a newer build
// (a headset restoring its tab does). The page asks the server which build is live and
// reloads once if it is not that one.

// What to do about the live build. mine, live: { sha, time }. tried: the build a reload was
// last made for. 'ok', 'reload', or 'stuck' when a reload for this build has not helped.
export function freshness(mine, live, tried) {
  const id = `${live.sha} ${live.time}`;
  if (live.sha === mine.sha && live.time === mine.time) return 'ok';
  return tried === id ? 'stuck' : 'reload';
}

const KEY = 'fv.reloadedFor';

export async function checkBuild(mine) {
  const res = await fetch('/build.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`build.json: HTTP ${res.status}`);
  const live = await res.json();
  const what = freshness(mine, live, sessionStorage.getItem(KEY));
  if (what === 'reload') {
    sessionStorage.setItem(KEY, `${live.sha} ${live.time}`);
    location.reload();
  } else if (what === 'stuck') {
    const note = document.getElementById('stale') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'stale' }));
    note.style.cssText = 'position:fixed;left:12px;bottom:12px;padding:8px 12px;font:14px/1.4 ui-monospace,monospace;color:#fff;background:#b02020;border-radius:6px;z-index:20';
    note.textContent = `old build ${mine.sha}: the server has ${live.sha} and a reload did not bring it`;
    console.error(note.textContent);
  }
  return what;
}
