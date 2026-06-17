// CSV export utilities ---------------------------------------------
function toCsv(rows, headers) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = v.toString();
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [];
  lines.push(headers.join(','));
  for (const r of rows) {
    lines.push(headers.map(h => escape(r[h])).join(','));
  }
  return lines.join('\n');
}

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export { toCsv, downloadCsv }; 