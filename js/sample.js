// Draws a small product-style photo (a mug on a table) so the app can be tried with no files at hand.
export async function makeSampleImage() {
  const W = 1400, H = 1050;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');

  // wall
  const wall = x.createLinearGradient(0, 0, W, H * 0.62);
  wall.addColorStop(0, '#9fb7a6');
  wall.addColorStop(1, '#6f8c7b');
  x.fillStyle = wall;
  x.fillRect(0, 0, W, H * 0.62);
  // window light on the wall
  const light = x.createRadialGradient(W * 0.25, H * 0.15, 20, W * 0.25, H * 0.15, W * 0.6);
  light.addColorStop(0, 'rgba(255,248,225,.55)');
  light.addColorStop(1, 'rgba(255,248,225,0)');
  x.fillStyle = light;
  x.fillRect(0, 0, W, H * 0.62);

  // table with wood grain
  const table = x.createLinearGradient(0, H * 0.62, 0, H);
  table.addColorStop(0, '#a8703f');
  table.addColorStop(1, '#6e4425');
  x.fillStyle = table;
  x.fillRect(0, H * 0.62, W, H * 0.38);
  x.globalAlpha = 0.18;
  for (let i = 0; i < 70; i++) {
    const y = H * 0.62 + Math.random() * H * 0.38;
    x.strokeStyle = Math.random() > 0.5 ? '#3d2412' : '#d9a06a';
    x.lineWidth = 1 + Math.random() * 3;
    x.beginPath();
    x.moveTo(0, y);
    for (let px = 0; px <= W; px += 70) x.lineTo(px, y + Math.sin(px / 140 + i) * 6);
    x.stroke();
  }
  x.globalAlpha = 1;

  const cx = W * 0.5, top = H * 0.3, bottom = H * 0.8, rw = 210;

  // contact shadow
  const sh = x.createRadialGradient(cx + 40, bottom, 10, cx + 40, bottom, rw * 1.6);
  sh.addColorStop(0, 'rgba(30,15,5,.55)');
  sh.addColorStop(1, 'rgba(30,15,5,0)');
  x.save(); x.scale(1, 0.25); x.fillStyle = sh; x.fillRect(0, (bottom - 120) / 0.25, W, 480 / 0.25); x.restore();

  // handle
  x.lineWidth = 48;
  x.strokeStyle = '#e8b33a';
  x.beginPath();
  x.ellipse(cx + rw + 12, (top + bottom) / 2 - 10, 92, 128, 0, -Math.PI / 2.1, Math.PI / 2.1);
  x.stroke();
  x.lineWidth = 14;
  x.strokeStyle = 'rgba(255,255,255,.25)';
  x.beginPath();
  x.ellipse(cx + rw + 12, (top + bottom) / 2 - 10, 92, 128, 0, -Math.PI / 3, Math.PI / 6);
  x.stroke();

  // body
  const body = x.createLinearGradient(cx - rw, 0, cx + rw, 0);
  body.addColorStop(0, '#b9801c');
  body.addColorStop(0.28, '#f6cc58');
  body.addColorStop(0.45, '#fff0b8');
  body.addColorStop(0.62, '#f2c230');
  body.addColorStop(1, '#a8700f');
  x.fillStyle = body;
  x.beginPath();
  x.moveTo(cx - rw, top);
  x.lineTo(cx - rw * 0.92, bottom - 30);
  x.quadraticCurveTo(cx - rw * 0.9, bottom + 6, cx, bottom + 8);
  x.quadraticCurveTo(cx + rw * 0.9, bottom + 6, cx + rw * 0.92, bottom - 30);
  x.lineTo(cx + rw, top);
  x.closePath();
  x.fill();

  // stripe
  x.fillStyle = 'rgba(29,74,58,.9)';
  x.fillRect(cx - rw * 0.97, top + 150, rw * 1.94, 34);

  // rim + coffee
  x.fillStyle = '#f7d77a';
  x.beginPath(); x.ellipse(cx, top, rw, 46, 0, 0, Math.PI * 2); x.fill();
  const coffee = x.createRadialGradient(cx - 30, top - 6, 4, cx, top, rw * 0.9);
  coffee.addColorStop(0, '#7a4a28');
  coffee.addColorStop(1, '#2b160a');
  x.fillStyle = coffee;
  x.beginPath(); x.ellipse(cx, top + 4, rw * 0.88, 36, 0, 0, Math.PI * 2); x.fill();

  // steam
  x.strokeStyle = 'rgba(255,255,255,.35)';
  x.lineCap = 'round';
  for (let s = -1; s <= 1; s++) {
    x.lineWidth = 10;
    x.beginPath();
    const sx = cx + s * 60;
    x.moveTo(sx, top - 30);
    x.bezierCurveTo(sx - 40, top - 90, sx + 40, top - 140, sx, top - 200);
    x.stroke();
  }

  // a little camera noise so it reads like a photo
  const img = x.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  x.putImageData(img, 0, 0);

  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
}
