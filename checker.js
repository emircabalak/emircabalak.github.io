// Leakage checker. Everything happens in this file, in your browser. No server, no upload.
// The pair test is the point: a leak split across two columns is invisible one column at a time.

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(",").map(s => s.trim());
  const rows = lines.slice(1).map(l => l.split(","));
  const cols = {};
  head.forEach((h, i) => {
    const raw = rows.map(r => (r[i] === undefined ? "" : r[i].trim()));
    const nums = raw.map(v => (v === "" ? NaN : Number(v)));
    const numericShare = nums.filter(v => Number.isFinite(v)).length / nums.length;
    cols[h] = numericShare > 0.9 ? { numeric: true, values: nums } : { numeric: false, values: raw };
  });
  return { head, cols, n: rows.length };
}

function corr(a, b) {
  const idx = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) idx.push(i);
  if (idx.length < 3) return NaN;
  const ma = idx.reduce((s, i) => s + a[i], 0) / idx.length;
  const mb = idx.reduce((s, i) => s + b[i], 0) / idx.length;
  let num = 0, da = 0, db = 0;
  for (const i of idx) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

// The majority class already scores this. Without it on the page, chance looks like a finding.
function baselineOf(y) {
  const v = y.filter(Number.isFinite);
  const p = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.max(p, 1 - p);
}

// Every pair is scanned against every row, so cost is columns squared times rows. Measured:
// 40 columns over 20k rows takes 12 seconds with the tab frozen and no way to cancel. Refusing
// with a number is better than looking dead.
const MAX_WORK = 8e6;

function pairScan(cols, head, labelName, threshold, minCoverage = 0.8) {
  const y = cols[labelName].values;
  const names = head.filter(h => h !== labelName && cols[h].numeric);
  const n = y.length;
  const work = names.length * names.length * n;
  if (work > MAX_WORK) {
    throw new Error(`Too big to check in a browser tab: ${names.length} numeric columns over ` +
      `${n} rows is about ${(work / 1e6).toFixed(0)} million comparisons and would freeze this ` +
      `page for a while. Cut it to a sample of rows, or drop columns you already trust.`);
  }
  const out = [];
  for (const a of names) {
    for (const b of names) {
      if (a === b) continue;
      const A = cols[a].values, B = cols[b].values;
      let ok = 0, agree = 0;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(A[i]) || !Number.isFinite(B[i]) || B[i] === 0 || !Number.isFinite(y[i])) continue;
        ok++;
        if (((A[i] / B[i] < threshold) ? 1 : 0) === y[i]) agree++;
      }
      if (ok < n * minCoverage) continue;
      out.push({ a, b, agreement: agree / ok, rows: ok });
    }
  }
  out.sort((x, z) => z.agreement - x.agreement);
  return out;
}

function sentinelScan(cols, head, labelName) {
  const out = [];
  for (const h of head) {
    if (h === labelName || !cols[h].numeric) continue;
    const v = cols[h].values.filter(Number.isFinite);
    const zeros = v.filter(x => x === 0).length;
    if (!zeros) continue;
    const nonzero = v.filter(x => x !== 0);
    if (!nonzero.length) continue;
    const floor = nonzero.reduce((m, x) => (x < m ? x : m), Infinity);
    const share = zeros / v.length;
    if (floor > 1 && share > 0.01) out.push({ column: h, zeros, share, floor });
  }
  return out;
}

function fmt(x, d = 4) { return Number.isFinite(x) ? x.toFixed(d) : "n/a"; }

// Column names come out of the pasted file and go into innerHTML. A header called
// <img src=x onerror=...> used to execute. Everything from the file goes through here now.
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function run(text, labelName, threshold) {
  const { head, cols, n } = parseCSV(text);
  if (!n) throw new Error("That is a header row with no data under it.");
  if (!Number.isFinite(threshold)) throw new Error("The threshold has to be a number.");
  if (!cols[labelName]) throw new Error(`No column named "${labelName}". Columns found: ${head.map(esc).join(", ")}`);
  if (!cols[labelName].numeric) throw new Error(`"${esc(labelName)}" is not numeric. The label has to be 0 and 1.`);

  const y = cols[labelName].values;
  const base = baselineOf(y);

  const singles = head
    .filter(h => h !== labelName && cols[h].numeric)
    .map(h => ({ column: h, r: corr(cols[h].values, y) }))
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  const pairs = pairScan(cols, head, labelName, threshold);
  const sentinels = sentinelScan(cols, head, labelName);

  const realPairs = pairs.filter(p => p.agreement - base > 0.05);
  const loudSingles = singles.filter(s => Math.abs(s.r) > 0.5);

  return { n, head, base, labelRate: y.filter(Number.isFinite).reduce((s, x) => s + x, 0) / y.filter(Number.isFinite).length,
           singles, pairs, sentinels, realPairs, loudSingles };
}

function render(res, el) {
  const p = [];
  const verdictClass = res.realPairs.length || res.loudSingles.length ? "bad" : "good";

  p.push(`<p class="verdict ${verdictClass}">`);
  if (res.realPairs.length) {
    p.push(`Found ${res.realPairs.length} column pair${res.realPairs.length > 1 ? "s" : ""} that rebuild the label.`);
  } else if (res.loudSingles.length) {
    p.push(`No leaking pair, but ${res.loudSingles.length} single column${res.loudSingles.length > 1 ? "s are" : " is"} implausibly predictive.`);
  } else {
    p.push(`Nothing above chance. No pair in this file reconstructs the label.`);
  }
  p.push(`</p>`);

  p.push(`<p class="meta">${res.n} rows, ${res.head.length} columns. Label rate ${fmt(res.labelRate, 3)}, so guessing the majority class already scores ${fmt(res.base, 4)}. That is the number to beat.</p>`);

  p.push(`<h3>Pairs, best five</h3><div class="table-scroll"><table><thead><tr><th>numerator</th><th>denominator</th><th class="num">agreement</th><th class="num">over baseline</th></tr></thead><tbody>`);
  for (const q of res.pairs.slice(0, 5)) {
    const over = q.agreement - res.base;
    p.push(`<tr class="${over > 0.05 ? "hit" : ""}"><td><code>${esc(q.a)}</code></td><td><code>${esc(q.b)}</code></td><td class="num">${fmt(q.agreement)}</td><td class="num">${over >= 0 ? "+" : ""}${fmt(over)}</td></tr>`);
  }
  p.push(`</tbody></table></div>`);

  p.push(`<h3>Single columns, strongest five</h3><div class="table-scroll"><table><thead><tr><th>column</th><th class="num">correlation with label</th></tr></thead><tbody>`);
  for (const s of res.singles.slice(0, 5)) {
    p.push(`<tr class="${Math.abs(s.r) > 0.5 ? "hit" : ""}"><td><code>${esc(s.column)}</code></td><td class="num">${fmt(s.r)}</td></tr>`);
  }
  p.push(`</tbody></table></div>`);

  if (res.realPairs.length) {
    const top = res.realPairs[0];
    p.push(`<p>The strongest single column here is <code>${esc(res.singles[0].column)}</code> at ${fmt(res.singles[0].r)}. Nobody investigates that. But <code>${esc(top.a)}</code> divided by <code>${esc(top.b)}</code> reproduces the label on ${fmt(top.agreement)} of ${top.rows} rows, which is ${fmt(top.agreement - res.base)} above chance.</p>`);
  }

  if (res.sentinels.length) {
    p.push(`<h3>Not leakage, but wrong anyway</h3><ul>`);
    for (const s of res.sentinels) {
      p.push(`<li><code>${esc(s.column)}</code> has ${s.zeros} zeros (${(s.share * 100).toFixed(1)}%) and its smallest non-zero value is ${s.floor}. A zero sitting that far below the floor is usually a missing marker, and any average over it is wrong before leakage is even a question.</li>`);
    }
    p.push(`</ul>`);
  }

  p.push(`<p class="meta">This checks ratios of numeric column pairs. A leak expressed as a difference, a product, or across three columns would walk straight past it. It also cannot tell when a column was computed, so a backfilled column with an innocent name and a mild correlation is invisible here.</p>`);

  el.innerHTML = p.join("");
}
