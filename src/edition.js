// What differs between where the app runs. This edition: pictures are saved to the device as
// downloads, and there is no report action and no telemetry.
export const REPORTS = false;
export const STORED_TO = 'saves to your downloads';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };

// Keeps a picture (data URL) or a report (JSON) as a download; resolves to its file name.
export function store(name, body) {
  const m = /^data:(image\/(?:jpeg|png));base64,/.exec(body);
  const file = m ? `${name}.${EXT[m[1]]}` : `${name}.json`;
  const url = m ? body : URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: file });
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!m) setTimeout(() => URL.revokeObjectURL(url), 0);
  return Promise.resolve(file);
}

// Starts what this edition runs beside the app; resolves to the telemetry handle, or null.
export function startEdition() {
  return Promise.resolve(null);
}
